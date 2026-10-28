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

**Costs.** Everything the test creates fits within Cloudflare's free allowances, and nothing should
ask for a payment card. File storage (Cloudflare R2, which needs a card on file) is left out of this
test, so product pictures, receipts and design files can't be uploaded yet.

**What it creates in your accounts:**
- a copy of this code in your GitHub account;
- a Worker (the app), a D1 database and a Durable Object in your Cloudflare account.

How to remove all of it is at the end. Nothing is sent to the OpenDecoDesk project: the app runs
entirely in your account.

## Steps

### 1. Press the button

Open this link, and sign in to Cloudflare and GitHub when asked. Please use this link rather than
Cloudflare's own "Create an app → import a repository": that route skips steps this app needs.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/opendecodesk-bot/odd-deploy-button-test)

### 2. Fill in Cloudflare's page

Cloudflare's page shows a few settings. Change these three and leave the rest as they are:

- **Create private Git repository**: tick it, so the copy in your GitHub account isn't public.
- **PROXY_ADMIN_PASSPHRASE** (your setup password): the box shows dots, but it holds example text.
  Click into it, delete everything, and type a password of **12 characters or more** that you make
  up. It isn't your Cloudflare or GitHub password. Write it down; you need it in step 5.
- **Enable Preview builds**: switch it off. This app doesn't use them.

Then click **Deploy**.

### 3. If it asks for a card or an upgrade

It shouldn't. If any page asks you to upgrade, switch on R2 or add a card, stop and tell us exactly
what it said (a screenshot is ideal).

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

**Forgot your password later?** Give the site a new setup password: in Cloudflare, open the Worker,
then **Settings → Variables and Secrets**, and change `PROXY_ADMIN_PASSPHRASE` to something new (12
characters or more). Then sign in with the email empty and that new setup password, and set your
email and password again. Everything you made is kept. The sign-in box has the same steps under
"Forgot your password?".

### 6. Look around (10 minutes)

Click through the back office as if you ran a small shop. You can build a shop with **New shop
setup** and look at it with **Preview**, but it can't open for orders yet: each shop's address is part
of your own domain, and setting up a domain isn't built into this test yet. Everything else is fair
game.

### 7. Optional: check an update keeps your data

This checks that a new build keeps your account and data.
1. In GitHub, open your copy of the code and edit any line of `README.md` with the pencil icon.
2. Commit the change. Cloudflare starts a new build by itself.
3. When it finishes, sign in with your own email and password. Is everything still there?

## Feedback

Please send these back to whoever gave you this link. Short answers are perfect.

1. **How far did you get?** (step number, and what you saw)
2. **What did Cloudflare's page ask for**, and was anything confusing?
3. **Did anything ask for a card or an upgrade?**
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

In **GitHub**: open your copy, then **Settings → Delete this repository** at the bottom.
