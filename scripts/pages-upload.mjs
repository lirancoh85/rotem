// Usage: node scripts/pages-upload.mjs <dir> <account-id> <project> <branch>  (API token injected by the session proxy;
// locally use `npm run deploy` with wrangler instead)
// Direct-upload a folder to Cloudflare Pages via the deployments endpoint (files sent inline).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
const { hash: blake3 } = require('blake3-wasm');
const [dir, account, project, branch] = process.argv.slice(2);
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const form = new FormData();
const manifest = {};
for (const file of walk(dir)) {
  const rel = '/' + relative(dir, file).split('\\').join('/');
  const buf = readFileSync(file);
  if (rel === '/_headers' || rel === '/_redirects') { form.append(rel.slice(1), new Blob([buf]), rel.slice(1)); continue; }
  const h = blake3(buf.toString('base64') + extname(file).slice(1)).toString('hex').slice(0, 32);
  manifest[rel] = h;
  form.append(h, new Blob([buf]), rel.slice(1));
}
form.append('manifest', JSON.stringify(manifest));
form.append('branch', branch);
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`, {
  method: 'POST', headers: { Authorization: 'Bearer proxy-injected' }, body: form,
});
const j = await res.json();
console.log(res.status, j.success, JSON.stringify(j.errors), j.result?.url, j.result?.id);
