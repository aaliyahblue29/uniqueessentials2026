// netlify/functions/create-checkout.js
//
// Creates a real, hosted Square Checkout page for the customer's current cart.
// Square hosts the entire payment page (card entry, Apple Pay, Google Pay),
// so no card data ever touches this server or your site's frontend.
//
// Required environment variables (set these in Netlify — never in your code):
//   SQUARE_ACCESS_TOKEN   -> Production access token from Square Developer Dashboard
//   SQUARE_LOCATION_ID    -> Your Square location ID
//   SQUARE_ENV            -> "production" or "sandbox" (defaults to "production")

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { items, tip, depositOnly, customer } = payload;

  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Cart is empty' }) };
  }

  // --- Basic server-side validation (never trust the browser alone) ---
  for (const it of items) {
    if (typeof it.price !== 'number' || it.price <= 0 || it.price > 500) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid item price' }) };
    }
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 50) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid item quantity' }) };
    }
  }

  const lineItems = items.map(it => ({
    name: `${it.name} (${it.size})`,
    quantity: String(it.qty),
    base_price_money: {
      amount: Math.round(it.price * 100), // cents
      currency: 'USD'
    }
  }));

  const tipAmount = Number(tip) || 0;
  if (tipAmount > 0) {
    lineItems.push({
      name: 'Tip',
      quantity: '1',
      base_price_money: { amount: Math.round(tipAmount * 100), currency: 'USD' }
    });
  }

  // NOTE: "Deposit only (50%)" is easiest to handle by charging 50% of the
  // order total as its own line item labeled clearly, rather than trying to
  // charge 50% of each product line. This keeps the Square order transparent
  // for both you and the customer.
  let finalLineItems = lineItems;
  if (depositOnly) {
    const fullTotalCents = lineItems.reduce(
      (sum, li) => sum + li.base_price_money.amount * Number(li.quantity), 0
    );
    const depositCents = Math.round(fullTotalCents * 0.5);
    finalLineItems = [{
      name: 'Deposit (50% of order total) — remainder due on delivery',
      quantity: '1',
      base_price_money: { amount: depositCents, currency: 'USD' }
    }];
  }

  const siteUrl = process.env.URL || 'https://uniqueessentials2026.netlify.app';
  const env = process.env.SQUARE_ENV === 'sandbox' ? 'sandbox' : 'production';
  const apiBase = env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';

  try {
    const res = await fetch(`${apiBase}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: cryptoRandomId(),
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          line_items: finalLineItems
        },
        checkout_options: {
          redirect_url: `${siteUrl}/?order=complete`
        },
        pre_populated_data: customer?.email
          ? { buyer_email: customer.email }
          : undefined
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Square error:', JSON.stringify(data));
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not create checkout session' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ checkoutUrl: data.payment_link.url })
    };
  } catch (err) {
    console.error('Checkout function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error creating checkout' }) };
  }
}

function cryptoRandomId() {
  // Node 18+ (Netlify's default runtime) has crypto.randomUUID globally
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}
