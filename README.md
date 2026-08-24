# Argand Tutors

A booking site for GCSE and A-Level maths, further maths, physics and computer science,
with an application system for new tutors that requires the owner's approval.

Put all three files in one folder:

```
your-folder/
├── server.js          the backend — no npm dependencies
├── package.json
├── index.html         the entire front end, single file
└── data.json          created on first run
```

A `public/` subfolder works too — the server checks both places.

## Run it locally

Needs Node 18 or newer.

```bash
node server.js
```

Open <http://localhost:3000>. That's the real thing — same code you'd deploy.

Without an email API key the server prints emails to the terminal instead of sending them,
so you can test the whole approval flow offline.

## Who can do what

**Tutors** have accounts, but they cannot create one themselves. They apply, the owner
receives a confirmation code by email, and the account only comes into existence once
that code is entered. After that it's an ordinary email-and-password login that stays
signed in across refreshes.

**Customers have no accounts and cannot create one.** They give a name and an email,
confirm the email with a code, and everything arrives by email: the booking details
plus a private link for viewing or cancelling that session. There is no customer
password anywhere in the system.

## Setting yourself up as the first tutor

The site starts with no tutors at all. To create the first account:

1. Go to `/#/apply` and fill in the form as yourself.
2. Look at the terminal window. Without an email key the confirmation code is
   printed there instead of emailed — copy the six digits.
3. Enter that code on the page. Your account is now live.
4. Sign in at `/#/staff`, open **Availability**, and set your weekly hours.
   **You won't appear on the public site until you do** — a tutor with no hours
   has nothing anyone can book.
5. Add a photo and finish your profile.

Once email is switched on the code goes to `OWNER_EMAIL` instead, which is what makes
this an approval system: an applicant never sees their own code.

## What the system does and doesn't do for you

**Handled and stored on the server:** tutor accounts, weekly availability, blocked
dates, buffers, profiles, photos, rates, bookings, cancellations with the 24-hour
refund rule, waitlist entries and the emails to you and the customer.

**Card payments** switch on the moment you set a `STRIPE_SECRET_KEY`. Without one the site runs
in invoice mode: bookings are still taken, and the confirmation email tells the customer their
tutor will arrange payment directly.

**Deliberately left out:** rescheduling. A customer cancels and rebooks. Half-working
rescheduling is worse than none, so the button is gone rather than pretending.

## The admin account

One permanent owner account, seeded on first run:

- **Email:** `argandtutors@gmail.com`
- **Password:** `Confazzled28@` — change it immediately, the console nags you until you do

It signs in at the same `/#/staff` page as tutors and lands on `/#/admin`. It is not a tutor:
it never appears in the public list, has no availability and can't be booked.

From the console you can:

- see every tutor, their contact details and whether they're active
- read their bank details (masked to the last four digits until you click Reveal — each reveal
  is logged to the terminal)
- edit any tutor's headline, phone, university or course
- deactivate a tutor, which removes them from the site without deleting their history
- see hours taught, sessions completed and **what you owe each of them**
- mark a tutor as paid once you've made the bank transfer

Owed is calculated from **finished** sessions only, after the platform commission
(20% by default — change with `PLATFORM_COMMISSION`). Marking as paid records the settlement;
it does not move any money. You make the transfer yourself.

## Bank details and security

Tutors give a UK account holder name, sort code and account number when they apply.

These are **encrypted with AES-256-GCM** before being written to disk. The key is generated on
first run and saved to `.enc-key` next to the server.

- **Back up `.enc-key`.** Lose it and the bank details are unrecoverable.
- **Never commit `.enc-key` or `data.json`.** The included `.gitignore` covers both — check it
  is there before your first push.
- On Render, set `ENCRYPTION_KEY` as an environment variable instead, so the key survives restarts.

You are storing bank details and children's contact details. That makes a privacy policy, a
retention rule and an ICO registration genuine obligations rather than nice-to-haves.

## Promo codes

Codes live near the top of `server.js`, in the `PROMOS` block:

```js
const PROMOS = {
  EPSILON: { percent: 20, label: "EPSILON", expires: null }
};
```

`EPSILON` gives 20% off and never expires. To add another, copy the line and change the name
and percentage. To make one temporary, set `expires` to a date like `"2026-12-31"`.

Codes are checked on the server, so a customer can't invent one or change the discount in
their browser. They stack with the 10% block-booking discount: four sessions at £50 with
EPSILON comes to £144 rather than £200.

## Prices

Each tutor sets their own hourly price per subject under **Profile → What you charge**. Leave a
box empty and they get the suggested price — the subject's base rate plus their premium. Fill it
in and that number is what customers pay. 30-minute sessions are 60% of the hourly rate,
90-minute are 145%.

Base rates for each subject are in the `SUBJECTS` list in `server.js`.

## Configuration

All optional — the site runs without any of them. Set them as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `OWNER_EMAIL` | `argandtutors@gmail.com` | **Where tutor applications and approval codes are sent** |
| `BREVO_API_KEY` | *(none)* | Turns on email via Brevo. Works without owning a domain |
| `RESEND_API_KEY` | *(none)* | Turns on email via Resend. Needs a verified domain |
| `BREVO_SENDER` | your `OWNER_EMAIL` | Address Brevo sends from — must be verified in Brevo |
| `FROM_EMAIL` | `Argand Tutors <onboarding@resend.dev>` | Sender for Resend |
| `STRIPE_SECRET_KEY` | *(none)* | **Turns on card payments.** `sk_test_…` for testing, `sk_live_…` for real money |
| `PUBLIC_URL` | `http://localhost:3000` | Used for links in emails and Stripe redirects |
| `CURRENCY` | `gbp` | Currency for payments |
| `DB_PATH` | `./data.json` | Where records are stored when there's no database |
| `DATABASE_URL` | *(none)* | Postgres connection string. Set it and records live there instead |
| `CONTACT_EMAIL` | your `OWNER_EMAIL` | Address shown on the contact page and in emails |
| `ADMIN_PASSWORD` | `Confazzled28@` | Initial admin password. Change it in the console after first sign-in |
| `PLATFORM_COMMISSION` | `0.2` | Starting cut. After first run, change it in the admin console instead |
| `ENCRYPTION_KEY` | *(auto-generated)* | Key for encrypting bank details. Set this on Render |

If both email keys are set, Brevo wins. With neither, emails print to the terminal.

## Switching on email

**Brevo — easiest, no domain needed.** Sign up at [brevo.com](https://brevo.com) with the same address
as `OWNER_EMAIL`. Go to SMTP & API, create an API key, and set `BREVO_API_KEY`. That's it — mail sends
to anyone straight away. Free plan is 300 emails a day. Two catches: emails carry a small "Sent with
Brevo" line, and until you verify a domain they arrive from a brevosend.com address rather than yours.

**Resend — nicer once you own a domain.** Create an API key, set `RESEND_API_KEY`, and verify
`argandtutors.co.uk` with the DNS records Resend gives you. Until that domain is verified it will only
deliver to your own address, which is fine for approving tutors but means customers never get their
booking codes.

Start on Brevo for the beta. Move to Resend when you buy the domain.

### Checking it works

```
node server.js --test-email
```

Sends one message to `OWNER_EMAIL` and tells you exactly what happened — including the
likely cause if it fails. Run this before you invite anyone; it's much quicker than
submitting a test application every time.

### The nine emails the system sends

| Trigger | Goes to |
|---|---|
| Someone applies to tutor | You |
| Application approved | The new tutor |
| Customer starts a booking | Customer (6-digit code) |
| Booking confirmed | Customer (details, receipt, cancel link) |
| Booking confirmed | Tutor |
| 24 hours before a session | Customer and tutor |
| 1 hour before a session | Customer |
| Booking cancelled | Customer (with refund status) |
| Booking cancelled | Tutor |

## Switching on card payments

1. Sign up at [stripe.com](https://stripe.com). No monthly fee — UK cards cost 1.5% + 20p per payment.
2. Copy your **test** secret key (starts `sk_test_`) from the Developers area.
3. Set `STRIPE_SECRET_KEY`. The startup line will say `Card payments: on, via Stripe (TEST MODE)`.
4. Book a session and pay with card number `4242 4242 4242 4242`, any future expiry, any CVC.
   No real money moves.
5. When you're happy, swap in the `sk_live_` key. Stripe will want your business details first.

**How the money flow works.** The slot is held, the customer verifies their email, then they're sent to
Stripe's own payment page. Nothing is booked until Stripe confirms the payment — and the server asks
Stripe directly rather than trusting the browser. Card details never touch your server. Cancelling more
than 24 hours ahead refunds the card automatically.

With no Stripe key set, the site runs in invoice mode instead: bookings are taken and the confirmation
email tells the customer their tutor will arrange payment directly. That's a perfectly reasonable way
to start.

## Running your beta

```
$env:OWNER_EMAIL="argandtutors@gmail.com"
$env:BREVO_API_KEY="xkeysib-your-key"
$env:STRIPE_SECRET_KEY="sk_test_your-key"
node server.js
```

(On Mac or Linux use `export` instead of `$env:`. On Render, add each one under Environment.)

Then: apply as yourself, take the code from your inbox, set your availability, and book a session as a
test parent using a second email address. You should end up with a real calendar invite, a Stripe test
payment, and emails on both sides.

## Putting it online

Free, and it survives restarts. Two services, both permanently free, neither needs a card:

### 1. The database — Neon

Render's free disk is wiped whenever the service restarts, which takes your tutors and bookings
with it. A free Postgres database fixes that permanently.

1. Sign up at [neon.tech](https://neon.tech) — free tier, no card, doesn't expire.
2. Create a project. Copy the **pooled** connection string; it looks like
   `postgres://user:pass@ep-xxx-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`.
3. Test it before deploying:
   ```
   $env:DATABASE_URL="postgres://…"
   node server.js --test-db
   ```
   It should say connected, table ready. Then start normally and your data goes to Neon
   rather than `data.json`.

With `DATABASE_URL` unset the site still uses the file, so nothing breaks locally.

### 2. The site — Render

1. Push the folder to GitHub (`.gitignore` keeps `data.json` and `.enc-key` out).
2. On [render.com](https://render.com), New → Web Service → your repo.
   Build `npm install`, start `node server.js`, Free instance.
3. Under Environment add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string |
| `ENCRYPTION_KEY` | the contents of your local `.enc-key` |
| `OWNER_EMAIL` | `argandtutors@gmail.com` |
| `BREVO_API_KEY` | your Brevo key |
| `PUBLIC_URL` | your `https://….onrender.com` address |

Render's free web service sleeps after 15 minutes idle and takes about a minute to wake, and you
get 750 instance-hours a month. Fine for alpha. About $7/month removes the sleep when you're ready.

**Why not the alternatives:** Render's own free Postgres expires 30 days after creation. Fly.io no
longer has a free tier for new accounts. Railway is a one-off trial credit. Supabase pauses free
projects after a week idle, which is exactly the failure mode you don't want. Neon scales to zero
instead of pausing, which is why it's the pick here.

## Before taking real money or real students

This runs and it's honest about what it does, but it is not finished:

- **`data.json` is not a real database.** Fine for a handful of tutors, wrong the moment you
  have concurrent writes. Move to Postgres before launch.
- **Bookings and payments are still front-end only.** The booking flow, availability, waitlist
  and recurring sessions all live in the browser and vanish on refresh. They need the same
  treatment as the application system: real endpoints, real rows, Stripe Checkout with a
  `checkout.session.completed` webhook, and the Postgres exclusion constraint so two people
  can't take one slot.
- **Sessions are a bare token.** For production, put it in an httpOnly, Secure, SameSite cookie.
- **You are handling children's data.** You need a privacy policy, a retention rule, a
  documented erasure process, and an ICO registration. Tutors working with under-18s need
  enhanced DBS certificates and you need a record that you checked them.
- **No admin area yet.** The owner currently approves by email. A proper console for
  subjects, tutors, bookings and refunds is the next thing to build.
