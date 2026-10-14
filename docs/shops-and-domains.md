# Shops and domains

## How addresses work

One install serves **one root domain**. Which page a visitor sees is decided by the address they
typed — the server reads the hostname of every request (`functions/_lib/hostConfig.js`).

| Address | What it is |
|---|---|
| `admin.myshop.com` | The admin panel. (`admin` is the default; `ADMIN_SUBDOMAIN` changes it.) |
| `league.myshop.com` | A shop — one per subdomain, each with its own products and settings. |
| `myshop.com`, `www.myshop.com` | The root domain: a generic page with your business name. No shop is shown here and no list of shops. |
| anything else | Refused. A mistyped subdomain is not quietly treated as the root. |

Three things follow from this:

- **A shop's customers can't discover your other shops.** The page they load contains no shop data
  at all; it asks the server "who am I?", and the server answers from the hostname with that one
  shop's name, products and prices. Nothing about any other shop is sent.
- **The admin only works on the admin address.** Admin requests are refused from a shop's address
  or the root domain, even with a valid sign-in.
- **Each hostname has to be attached to the Worker** before it loads. That is what the rest of this
  page is about.

The root domain does **not** have to point at OpenDecoDesk. If `myshop.com` is already your
business's website, leave it alone — only the admin and shop subdomains need to reach the Worker.

## The admin hostname

`npm run setup` adds your admin hostname to `wrangler.toml` as a **custom domain**:

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
]
```

With `custom_domain = true`, Cloudflare creates the DNS record and the certificate for that
hostname when the Worker is deployed. If the hostname **already has a DNS record**, the deploy is
refused — delete the old record in the Cloudflare dashboard first.

## Adding a shop

In the admin: **Manage catalog → + New Org**.

1. Fill in the shop's **id** (permanent, used internally), its **subdomain**, its name and
   description, an accent color, and optionally its pictures, order deadline, delivery options,
   payment methods and tax exemption. The subdomain is one word: letters, numbers and inner
   hyphens. `www`, `api`, `images` and your admin subdomain can't be used.
2. **Products** → **+ New Product** for each item, or **Import CSV**.
3. Tick **ready** on the shop when it should start taking orders. A shop that isn't ready shows a
   "not open yet" page and refuses orders.
4. **Publish** (below).
5. Attach the shop's hostname (below).

Nothing here needs a code change. Attaching the hostname needs one `npm run deploy`, unless
automatic hostnames are set up.

## Publish

The storefront reads shops and products through a cache, so a page view doesn't cost a database
read. **Publish** (Manage catalog → Publish) tells every part of the site to use the current
database contents from now on.

- **Shops, products, prices, pictures and the payment-method switches** reach the storefront when
  you Publish.
- **Orders are always priced from the database**, published or not: a price you changed is what
  the next order is charged, and a product you hid can't be ordered, even from a page that still
  shows the old catalog.
- **These don't need Publish** — they refresh the cache themselves when saved: the business
  profile, Region, Sales tax and the Feature switches.
- As a safety net the cache also expires by itself after a few minutes.

## Attaching a shop's hostname

### Automatically

If **Automatic hostnames for new shops** is set up (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
`CF_WORKER_NAME` — the installer asks), creating a shop attaches `<subdomain>.<root domain>` to the
Worker as a custom domain. Cloudflare creates the DNS record and certificate.

- The result is shown when the shop is created and is written to the audit log. A failure never
  stops the shop from being created.
- The shop's **Edit** page has a **Custom domain** box showing the current state, with buttons to
  set it up or check again.
- A hostname that **already has a DNS record** is refused rather than overwritten — remove the
  record first.
- Changing a shop's subdomain later does **not** remove the old hostname; set up the new one from
  the Edit page and remove the old one in the Cloudflare dashboard.

**The API token.** It needs permission to edit Workers scripts on the account, to edit Workers
routes on the zone, and to read the zone's DNS (this is what `functions/_lib/customDomain.js`
documents; the exact permission names are Cloudflare's and may change). It is the most powerful
secret the site holds: it is only used by the admin's create-shop and set-up-domain actions and is
never sent to a browser, but create it for this one zone, with nothing more than it needs.

### By hand

After creating the shop in the admin, run:

```bash
npm run deploy
```

It reads every shop from the database, adds a line for each to the hostnames block the installer
wrote in `wrangler.toml`, and deploys. Cloudflare then creates the DNS record and certificate; a
hostname attached for the first time can take a few minutes to start answering.

```toml
routes = [
  { pattern = "admin.myshop.com", custom_domain = true },
  { pattern = "league.myshop.com", custom_domain = true },
]
```

> **Always deploy with `npm run deploy`, not a bare `npx wrangler deploy`.** A deploy makes the
> Worker's hostnames exactly the ones listed in `wrangler.toml`. A hostname attached any other
> way — in the Cloudflare dashboard (the Worker → Settings → Domains & Routes), or by the admin
> when a shop was created — is **detached by the next deploy**, with its DNS record, and the shop
> stops loading. This was seen on a real install. `npm run deploy` lists every shop first, so
> nothing is dropped; `npm run setup` does the same when it is run again.
>
> If a shop went offline this way, run `npm run deploy`. The hostname is attached again; give it
> a few minutes, since the address was briefly gone and computers remember that for a while.

## Turning the storefront off

With **Global settings → Features → Storefront** off, every shop address and the root domain show
"Online ordering isn't available here." and the server takes no customer orders. Shops, products,
"ready", Publish and hostnames all still work in the admin, ready for when it is turned back on.

## A shop's own settings

Manage catalog → the shop → **Edit**:

- **Delivery & pickup** — the list customers choose from: local pickup, carrier shipping (US, with
  the Shipping feature), and any number of your own options with a flat fee.
- **Payment methods** — a shop can turn off methods that are on site-wide; it can't turn on one
  that is off site-wide.
- **Order deadline** — a date, a message for afterwards, and whether orders are still accepted
  after it.
- **Sales tax** — tax exemption (see [sales-tax.md](sales-tax.md)).
- **Reorder QR code & option prices** — for configurable products.

## Products without a blank

Linking a product to a blank (Blank links on the product) is optional. Without one the product
saves and sells as usual; the catalog check marks it in amber, because its stock and cost of goods
aren't tracked. A configurable product's colors normally come from the blanks ticked for it — with
no blank, type the colors in by name instead.

## Customers' own designs

A product can let the customer upload their own artwork (Manage catalog → the product → **Customer's
own design**):

- **Embroidery** — you digitize the customer's image and upload the stitch file for that line (Orders
  → Edit items → Files → Order design) before Digitizing complete. The customer approves the proof
  as for a typed-in name, and Run Order runs the stitch file you uploaded.
- **Transfer** — the line goes to Run Transfer Sheets with the customer's image, printed as uploaded.
- **Add-on per piece** — added to the price, like a graphic's add-on. Blank means free. A
  configurable product can set its own add-on at each location (under the location, in the product's
  graphics); a location left blank uses the product's.

On an ordinary product with no design of its own the upload is **required** (and the catalog check
doesn't flag the product for having no design). On one with a design the customer can choose
**Use my own design instead**, which replaces that design on that item. A configurable product
offers **Custom — upload your own** at each location, and the customer can use it at as many
locations as they like. Stitched, each of those locations gets its own order design: Files shows
an **Order design** slot per location, and each one's hooping on Run Order waits for its stitch file.

What the shop page accepts: PNG, JPG or WebP, up to 10 MB, at least 500 px on the long side and at
most 10,000 px on either side. A transfer under 1,500 px gets a warning that it may print soft. The
server checks all of this again. Uploads go to the private `DESIGNS` bucket (see
[configuration.md](configuration.md)), so the setting needs file storage. An upload that never
made it onto an order is deleted after 48 hours.

The customer's file is on the order line under **Files**, with a picture; it can be downloaded but
not deleted. Adding a customer's design from the admin (Edit items, a local sale) isn't offered:
attach the file under Files instead.
