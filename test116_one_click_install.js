const fs = require("fs");
const { makeAuth, read, strip } = require("./testlib/auth-harness");

// Installing with the Deploy to Cloudflare button. The button copies this repository, makes the
// database and buckets, asks for the secrets listed in .dev.vars.example (with the descriptions in
// package.json) and runs `npm run deploy` in Cloudflare's build. The site has no domain then: its
// admin answers on the Worker's own workers.dev address, and the first sign-in is with the setup
// password the owner chose on Cloudflare's page — refused while it is the example's placeholder or
// too short, because that address is public from the moment it is deployed.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== The admin on the workers.dev address ===");
  const { classifyHost } = new Function(strip(read("functions/_lib/hostConfig.js")) + "\nreturn { classifyHost };")();
  const env = { ROOT_DOMAIN: "myshop.com" }, map = { league: "league-101" };
  ok("the Worker's own address (<worker>.<account>.workers.dev) is the admin", classifyHost("opendecodesk.someone.workers.dev", map, {}).kind === "admin" && classifyHost("OpenDecoDesk.Someone.workers.dev.", map, env).kind === "admin");
  ok("nothing else that merely mentions workers.dev is: a deeper name, the bare domain, or a look-alike under another domain", ["a.b.c.workers.dev", "someone.workers.dev", "workers.dev", "opendecodesk.someone.workers.dev.evil.com", "opendecodesk.someone.workers.devx", "op_x.someone.workers.dev"]
    .every(h => classifyHost(h, map, env).kind === "unknown"));
  ok("shops and the admin on the real domain are as before", classifyHost("league.myshop.com", map, env).kind === "locked" && classifyHost("admin.myshop.com", map, env).kind === "admin" && classifyHost("myshop.com", map, env).kind === "root");

  console.log("\n=== The setup password ===");
  const placeholder = (read(".dev.vars.example").match(/^PROXY_ADMIN_PASSPHRASE=(.*)$/m) || [])[1];
  for (const [what, secret] of [["the example's placeholder", placeholder], ["a short one", "short-pass1"]]) {
    const A = await makeAuth({ passphrase: secret });
    const a = await A.signIn("", secret);
    ok(`${what} doesn't open a new site, says where to change it, and creates nothing`, a.status === 403 && a.body.code === "weak_setup_password" && /Variables and Secrets/.test(a.body.message) && !a.cookie && A.d1.q("SELECT count(*) n FROM users")[0].n === 0);
  }
  const A = await makeAuth({ passphrase: "a long setup password" });
  ok("a setup password of 12 characters or more does", (await A.signIn("", "a long setup password")).body.pending === "account");

  console.log("\n=== What the button reads ===");
  const example = read(".dev.vars.example").split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const pkg = JSON.parse(read("package.json")), toml = read("wrangler.toml");
  ok(".dev.vars.example asks for the setup password only, and its value is the placeholder the site refuses", example.length === 1 && example[0] === "PROXY_ADMIN_PASSPHRASE=" + placeholder &&
    new RegExp('SETUP_PASSWORD_PLACEHOLDER = "' + placeholder + '"').test(read("functions/_lib/adminAuth.js")));
  ok("every value it asks for has a description written for someone who isn't technical", example.every(l => { const d = ((pkg.cloudflare || {}).bindings || {})[l.split("=")[0]]; return d && d.description.length > 80 && /workers\.dev/.test(d.description) && !/wrangler|CLI|terminal/i.test(d.description); }));
  ok("the build runs `npm run deploy`, which makes a new database's tables and manages the hostnames", pkg.scripts.deploy === "node scripts/deploy.mjs" && /process\.env\.WORKERS_CI/.test(read("scripts/deploy.mjs")) && !!pkg.version);
  ok("wrangler.toml works as the button finds it: the DB binding, the workers.dev address on, no previews, no active hostname list", /^\[\[d1_databases\]\]\nbinding = "DB"/m.test(toml) && /^workers_dev = true$/m.test(toml) && /^preview_urls = false$/m.test(toml) && !/^routes\s*=/m.test(toml));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test116 crashed:", e); console.log("test116 crashed: false"); });
