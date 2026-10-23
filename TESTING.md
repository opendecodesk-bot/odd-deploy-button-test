# Testing the one-click install

Thank you for trying this. OpenDecoDesk is shop software for embroidery and garment decoration
businesses that runs in your own Cloudflare account. Today, installing it needs a terminal and a
long list of steps. We're replacing that with a **Deploy to Cloudflare** button, and this copy is
the first try at it.

**You are one of the first people to press this button, so things may break.** Something breaking,
and you telling us where, is a useful result. Nobody expects you to fix anything.

This test covers **installing and signing in**. Taking orders, card payments, shipping labels and
email aren't set up by the button yet, so they're out of scope this time.

## What you need

- About 20–30 minutes.
- A **Cloudflare account**. A new, free one is best, because we want to see what a newcomer meets.
  Sign up at <https://dash.cloudflare.com/sign-up>.
- A **GitHub account** (free). The button saves a copy of the code there. Sign up at
  <https://github.com/signup>.

You don't need a domain name, a terminal, or any programming.

**Costs.** Everything the test creates fits within Cloudflare's free allowances. One part, R2 file
storage, asks for a payment card on file even though the free allowance is $0. If Cloudflare asks
you to switch on R2 or add a card, see step 3.

**What it creates in your accounts:**
- a copy of this code in your GitHub account;
- a Worker (the app), a D1 database, a Durable Object and possibly three R2 storage buckets in your
  Cloudflare account.

How to remove all of it is at the end. Nothing is sent to the OpenDecoDesk project: the app runs
entirely in your account.

## Steps

### 1. Press the button

Open this link, and sign in to Cloudflare and GitHub when asked:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/opendecodesk-bot/odd-deploy-button-test)

### 2. Choose a setup password

Cloudflare's page shows a few settings. Most can stay as they are. One, **PROXY_ADMIN_PASSPHRASE**,
is filled in with example text: replace it with a password of **12 characters or more** that you
make up. It isn't your Cloudflare or GitHub password. Write it down; you need it in step 5.

Then click **Deploy** (or **Create and deploy**).

### 3. If it asks about R2

R2 is Cloudflare's file storage, used for product pictures and receipts. It needs a card on file,
even at $0. Either choice is fine for this test:
- **Switch it on** if you're comfortable adding a card. The free allowance is far more than this
  test uses.
- **Stop here** if you'd rather not, and tell us exactly what the page said. That alone is a useful
  result.

### 4. Wait for the build

Cloudflare builds and deploys the app, which takes a few minutes. When it finishes, it shows an
address ending in **`workers.dev`**.

If it fails, open the build log. In the Cloudflare dashboard, go to **Workers & Pages**, open the
Worker (named `opendecodesk` or similar), then look under **Deployments** or **Builds** for the
latest build and its log. Please copy the whole log into your feedback.

### 5. Sign in for the first time

Open the `workers.dev` address.
1. Leave **email empty**, type the **setup password** from step 2, and sign in.
2. It asks for your name, email and a new password. These become your own sign-in. After that, the
   setup password stops working.
3. Sign in again with your new email and password.

If it says the setup password is still the example one or too short: in Cloudflare, open the Worker,
then **Settings → Variables and Secrets**, change `PROXY_ADMIN_PASSPHRASE`, and try again.

### 6. Look around (10 minutes)

Click through the back office as if you ran a small shop. **Please don't create a shop or set a
domain:** those need setup steps that aren't built yet, and they will fail on a `workers.dev`
address. Everything else is fair game.

### 7. Optional: check an update keeps your data

This checks that a new build keeps your account and data.
1. In GitHub, open your copy of the code and edit any line of `README.md` with the pencil icon.
2. Commit the change. Cloudflare starts a new build by itself.
3. When it finishes, sign in with your own email and password. Is everything still there?

## Feedback

Please send these back to whoever gave you this link. Short answers are perfect.

1. **How far did you get?** (step number, and what you saw)
2. **What did Cloudflare's page ask for**, and was anything confusing?
3. **Did it ask about R2 or a card?** What did you choose?
4. **Did the build succeed?** If not, the build log.
5. **First sign-in:** did it work, and was it clear what to do?
6. **Looking around:** what was confusing, what looked broken, and what would you expect to find
   that wasn't there?
7. **Step 7** (if you did it): did your account and data survive?
8. **Anything else**, including what you expected the button to do that it didn't.

Screenshots help. **Please never send passwords or keys**, and check build logs for anything you'd
rather not share before sending them.

## Removing the test

In the **Cloudflare dashboard**:
- **Workers & Pages**: delete the Worker.
- **D1**: delete the `opendecodesk-db` database.
- **R2**, if created: empty and delete the `opendecodesk-…` buckets.

In **GitHub**: open your copy, then **Settings → Delete this repository** at the bottom.
