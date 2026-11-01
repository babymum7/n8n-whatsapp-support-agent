# End-to-end run

- When: 2026-11-01T08:57:56.237Z
- Stack: `docker-compose.yml` (n8n 2.45.7, Ollama 0.40.13 with `nomic-embed-text`); chat model `deepseek-v4.1-flash` through an OpenAI-compatible Chat Completions endpoint
- Execution modes: hosted chat `webhook`, support agent `integrated`, tools `integrated`; knowledge-ingest runs: 1
- Result: all checks pass

## 1. An English question is answered from the knowledge base (pass)

**Customer:** When is your support team available?

**Assistant:**

> Our team is available 10:00–18:30 IST, Monday to Saturday, and is closed on Sundays and national holidays. I'm here any time — messages that arrive outside those hours get answered on the next working day. You can also email help@pranapath.example. Since today is Sunday, the team will reply tomorrow.

- pass: reply states the 18:30 IST closing time
- Agent: 2 model call(s), 3120 prompt and 122 completion tokens; tools used: search_faq ×1

## 2. A Hindi question gets a Hindi answer from the knowledge base (pass)

**Customer:** मुझे रिफंड माँगने के लिए कितने दिन मिलते हैं?

**Assistant:**

> रिफंड की खिड़की खरीद की तारीख से **11 दिन** है — उसके बाद रिफंड नहीं हो सकता, सिर्फ़ डबल चार्ज के मामले में छूट है।
> 
> - टीम हर रिफंड रिक्वेस्ट **2 कार्य-दिवसों** में देखती है।
> - मंज़ूरी के बाद पैसा **5 से 7 कार्य-दिवसों** में उसी पेमेंट मोड पर लौटता है।
> - रिफंड होने पर प्रोग्राम की एक्सेस हट जाती है।
> 
> अगर आप रिफंड चाहते हैं तो बताइए, मैं टिकट खोल देता हूँ।

- pass: at least half of the letters are Devanagari (100%)
- pass: reply states the 11-day window
- Agent: 2 model call(s), 3167 prompt and 317 completion tokens; tools used: search_faq ×1

## 3. A purchase question quotes the caller's own payment (pass)

**Customer:** Hi, I paid for the 21-Day Breathwork Reset on 28 October. Did my payment go through?

**Assistant:**

> Yes — your payment went through. ₹1,499 for the 21-Day Breathwork Reset was captured on 28 October, payment id pay_Qd7Lm2Xa9Kp4Tz, and your access is active.
> 
> There was also a card attempt on the same day that was declined by the bank (pay_Qd7Kx8Rb3Nw6Hc) — no money was taken for it.
> 
> Anything else I can help with?

- pass: tool-purchase-lookup ran successfully (1 run(s))
- pass: reply quotes pay_Qd7Lm2Xa9Kp4Tz
- Agent: 2 model call(s), 2445 prompt and 213 completion tokens; tools used: lookup_purchases ×1

## 4. A refund request becomes a ticket (pass)

**Customer:** I'd like a refund for the 21-Day Breathwork Reset, please. It isn't right for me.

**Assistant:**

> I've opened a refund request for you — ticket **TKT-1** — for the 21-Day Breathwork Reset, payment **pay_Qd7Lm2Xa9Kp4Tz** (₹1,499, paid 28 Oct 2026). Since it's within 11 days of purchase, it's eligible for review.
> 
> The team reviews refund requests within 2 working days; today is Sunday, so you'll hear from them on the next working day. If approved, the money returns to your original payment method in 5–7 working days, and program access is removed when the refund is processed.

- pass: tool-handoff ran successfully (1 run(s))
- pass: a row was added to the support_tickets Data Table (id 1, kind refund, status open)
- pass: reply gives a TKT-<number> ticket id (TKT-1)
- pass: the ticket id matches the added row
- Agent: 3 model call(s), 5829 prompt and 425 completion tokens; tools used: lookup_purchases ×1, search_faq ×1, hand_off ×1
