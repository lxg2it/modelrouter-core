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
export interface StripePaymentMethod {
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
}
export interface StripeCustomerInfo {
    id: string;
    email?: string;
    name?: string;
    defaultPaymentMethodId?: string;
}
export interface SetupIntentResult {
    setupIntentId: string;
    clientSecret: string;
}
export interface CheckoutSessionResult {
    url: string;
    sessionId: string;
}
export interface TopUpResult {
    paymentIntentId: string;
    amountCents: number;
    /** 'succeeded' = credits are ready. 'requires_action' = 3DS redirect needed. */
    status: 'succeeded' | 'requires_action' | 'processing' | 'requires_payment_method';
    /** Present when status is 'requires_action' — pass to client for 3DS handling. */
    clientSecret?: string;
}
export declare class StripeService {
    private readonly _stripe?;
    private stripe;
    /**
     * @param secretKey  Stripe secret key (sk_live_... or sk_test_...)
     */
    constructor(secretKey: string, _stripe?: Stripe | undefined);
    /**
     * Create a new Stripe customer.
     * Called once when a user first sets up billing.
     * Returns the Stripe customer ID (e.g. "cus_abc123").
     */
    createCustomer(params: {
        name?: string;
        email?: string;
        metadata?: Record<string, string>;
    }): Promise<string>;
    /**
     * Retrieve a Stripe customer by ID.
     */
    getCustomer(stripeCustomerId: string): Promise<StripeCustomerInfo>;
    /**
     * Create a SetupIntent that allows a frontend to securely collect and save
     * a payment method without charging it.
     *
     * The returned `clientSecret` should be passed to Stripe.js on the frontend,
     * which uses it to render the card entry form and confirm the setup.
     */
    createSetupIntent(stripeCustomerId: string): Promise<SetupIntentResult>;
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
    createCheckoutSession(stripeCustomerId: string, successUrl: string, cancelUrl: string): Promise<CheckoutSessionResult>;
    /**
     * Retrieve a completed Checkout session and extract the payment method ID from its
     * SetupIntent. Returns null if the session has no payment method yet.
     */
    getCheckoutPaymentMethod(sessionId: string): Promise<string | null>;
    /**
     * Attach a payment method to a customer and set it as default.
     * Called after a SetupIntent is confirmed on the frontend.
     */
    attachPaymentMethod(stripeCustomerId: string, paymentMethodId: string): Promise<StripePaymentMethod>;
    /**
     * List all saved payment methods for a customer.
     */
    listPaymentMethods(stripeCustomerId: string): Promise<StripePaymentMethod[]>;
    /**
     * Get a specific payment method's card details.
     */
    getPaymentMethod(paymentMethodId: string): Promise<StripePaymentMethod>;
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
    charge(stripeCustomerId: string, amountCents: number, description: string): Promise<TopUpResult>;
    private extractCardInfo;
}
//# sourceMappingURL=stripe.d.ts.map