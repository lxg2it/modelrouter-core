/**
 * StripeService — wrapper around the Stripe API for customer and payment management.
 *
 * Responsibilities:
 *   - Create customers (one per API key, on first billing interaction)
 *   - Create SetupIntents (for saving cards without immediate charge)
 *   - Attach payment methods to customers
 *   - Charge customers for credit top-ups
 *   - List payment methods for display
 *
 * The service is pure (no database access). The billing API routes
 * handle persistence by updating the KeyStore after Stripe calls succeed.
 */
import Stripe from 'stripe';
// ─── StripeService ────────────────────────────────────────
export class StripeService {
    _stripe;
    stripe;
    /**
     * @param secretKey  Stripe secret key (sk_live_... or sk_test_...)
     */
    constructor(secretKey, 
    // Allow injection for testing (Stripe instance mock)
    _stripe) {
        this._stripe = _stripe;
        this.stripe = _stripe ?? new Stripe(secretKey);
    }
    // ─── Customers ──────────────────────────────────────────
    /**
     * Create a new Stripe customer.
     * Called once when a user first sets up billing.
     * Returns the Stripe customer ID (e.g. "cus_abc123").
     */
    async createCustomer(params) {
        const customer = await this.stripe.customers.create({
            name: params.name,
            email: params.email,
            metadata: params.metadata ?? {},
        });
        return customer.id;
    }
    /**
     * Retrieve a Stripe customer by ID.
     */
    async getCustomer(stripeCustomerId) {
        const customer = await this.stripe.customers.retrieve(stripeCustomerId);
        if (customer.deleted) {
            throw new Error(`Stripe customer ${stripeCustomerId} has been deleted`);
        }
        const c = customer;
        return {
            id: c.id,
            email: c.email ?? undefined,
            name: c.name ?? undefined,
            defaultPaymentMethodId: typeof c.invoice_settings?.default_payment_method === 'string'
                ? c.invoice_settings.default_payment_method
                : c.invoice_settings?.default_payment_method?.id,
        };
    }
    // ─── Payment methods ────────────────────────────────────
    /**
     * Create a SetupIntent that allows a frontend to securely collect and save
     * a payment method without charging it.
     *
     * The returned `clientSecret` should be passed to Stripe.js on the frontend,
     * which uses it to render the card entry form and confirm the setup.
     */
    async createSetupIntent(stripeCustomerId) {
        const intent = await this.stripe.setupIntents.create({
            customer: stripeCustomerId,
            usage: 'off_session', // So we can charge later without user being present
            payment_method_types: ['card'],
        });
        if (!intent.client_secret) {
            throw new Error('Stripe SetupIntent created without client_secret');
        }
        return {
            setupIntentId: intent.id,
            clientSecret: intent.client_secret,
        };
    }
    /**
     * Create a Stripe Hosted Checkout session for saving a payment method (mode: 'setup').
     *
     * The user is redirected to Stripe's hosted checkout page (checkout.stripe.com)
     * where they enter their card details securely. On success, Stripe redirects back to
     * successUrl with `?session_id={CHECKOUT_SESSION_ID}`.
     *
     * The caller must then retrieve the session, extract the SetupIntent's payment_method,
     * and attach it to the customer.
     *
     * @param stripeCustomerId  Stripe customer ID
     * @param successUrl        URL to redirect to after successful card save (include {CHECKOUT_SESSION_ID} placeholder if desired)
     * @param cancelUrl         URL to redirect to if user cancels
     */
    async createCheckoutSession(stripeCustomerId, successUrl, cancelUrl) {
        const session = await this.stripe.checkout.sessions.create({
            customer: stripeCustomerId,
            mode: 'setup',
            payment_method_types: ['card'],
            success_url: successUrl,
            cancel_url: cancelUrl,
        });
        if (!session.url) {
            throw new Error('Stripe Checkout session created without redirect URL');
        }
        return {
            url: session.url,
            sessionId: session.id,
        };
    }
    /**
     * Retrieve a completed Checkout session and extract the payment method ID from its
     * SetupIntent. Returns null if the session has no payment method yet.
     */
    async getCheckoutPaymentMethod(sessionId) {
        const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['setup_intent.payment_method'],
        });
        if (!session.setup_intent)
            return null;
        const si = session.setup_intent;
        if (!si.payment_method)
            return null;
        return typeof si.payment_method === 'string'
            ? si.payment_method
            : si.payment_method.id;
    }
    /**
     * Attach a payment method to a customer and set it as default.
     * Called after a SetupIntent is confirmed on the frontend.
     */
    async attachPaymentMethod(stripeCustomerId, paymentMethodId) {
        // Attach the PM to the customer
        await this.stripe.paymentMethods.attach(paymentMethodId, {
            customer: stripeCustomerId,
        });
        // Set as the default for future invoices and charges
        await this.stripe.customers.update(stripeCustomerId, {
            invoice_settings: { default_payment_method: paymentMethodId },
        });
        // Return PM details for display
        return this.getPaymentMethod(paymentMethodId);
    }
    /**
     * List all saved payment methods for a customer.
     */
    async listPaymentMethods(stripeCustomerId) {
        const pms = await this.stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: 'card',
        });
        return pms.data.map((pm) => this.extractCardInfo(pm));
    }
    /**
     * Get a specific payment method's card details.
     */
    async getPaymentMethod(paymentMethodId) {
        const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId);
        return this.extractCardInfo(pm);
    }
    // ─── Charging ────────────────────────────────────────────
    /**
     * Charge a customer's saved payment method for a credit top-up.
     *
     * Uses the customer's default payment method (`invoice_settings.default_payment_method`).
     * If the card requires 3DS authentication, status will be 'requires_action' and
     * the client should use `clientSecret` with Stripe.js to complete it.
     *
     * @param stripeCustomerId  Stripe customer ID
     * @param amountCents       Amount in cents (e.g. 1000 = $10.00)
     * @param description       Human-readable description for the charge
     */
    async charge(stripeCustomerId, amountCents, description) {
        if (amountCents < 50) {
            throw new Error(`Minimum charge is $0.50 (50 cents). Requested: ${amountCents} cents.`);
        }
        // Get customer to find default payment method
        const customer = await this.stripe.customers.retrieve(stripeCustomerId);
        const defaultPmId = typeof customer.invoice_settings?.default_payment_method === 'string'
            ? customer.invoice_settings.default_payment_method
            : customer.invoice_settings?.default_payment_method?.id;
        if (!defaultPmId) {
            throw new Error('Customer has no default payment method. Add a card first.');
        }
        // Create and confirm a PaymentIntent in one step
        const intent = await this.stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            customer: stripeCustomerId,
            payment_method: defaultPmId,
            description,
            confirm: true,
            // Allow 3DS if needed (off_session = user is not actively present)
            off_session: true,
            // Expand the payment method for confirmation
            expand: ['payment_method'],
        });
        return {
            paymentIntentId: intent.id,
            amountCents,
            status: intent.status,
            clientSecret: intent.status === 'requires_action'
                ? intent.client_secret ?? undefined
                : undefined,
        };
    }
    // ─── Helpers ─────────────────────────────────────────────
    extractCardInfo(pm) {
        if (!pm.card) {
            throw new Error(`Payment method ${pm.id} is not a card`);
        }
        return {
            id: pm.id,
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
        };
    }
}
//# sourceMappingURL=stripe.js.map