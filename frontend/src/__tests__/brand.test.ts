import fs from 'fs';
import path from 'path';
import { brand } from '../brand';

// The rebrand to vedan keeps every INTERNAL `srckube` identifier (databases,
// the Keycloak realm, @srckube/service-core). This guards the other side of
// that line: the files a customer actually sees must never say srcKube again.
const ROOT = path.resolve(__dirname, '../../..');
const CUSTOMER_VISIBLE = [
  'frontend/public/index.html',
  'frontend/public/manifest.json',
  'keycloak-themes/themes/kdk/login/template.ftl',
  'keycloak-themes/themes/kdk/login/fragments/banner.ftl',
  'backend/userService/controllers/invites.js',
];

describe('vedan brand', () => {
  it.each(CUSTOMER_VISIBLE)('%s does not mention the old product name', (rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Code comments and identifiers like require('@srckube/service-core') are
    // internal and allowed; strings, prose and markup are not.
    const visible = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/@srckube\/[\w-]+/g, '');
    expect(visible).not.toMatch(/src\s*\/?\s*kube/i);
  });

  it('every brand asset the app references is shipped', () => {
    Object.values(brand.assets).forEach((asset) => {
      expect(fs.existsSync(path.join(ROOT, 'frontend/public', asset))).toBe(true);
    });
  });

  // template.ftl links img/favicon.ico; when the theme lacked the file,
  // Keycloak silently served its parent theme's icon instead.
  it('the login theme ships the same favicon as the app', () => {
    const app = fs.readFileSync(path.join(ROOT, 'frontend/public/favicon.ico'));
    const login = fs.readFileSync(path.join(ROOT, 'keycloak-themes/themes/kdk/login/resources/img/favicon.ico'));
    expect(login.equals(app)).toBe(true);
  });

  it('the page title is the product name', () => {
    const html = fs.readFileSync(path.join(ROOT, 'frontend/public/index.html'), 'utf8');
    expect(html).toMatch(new RegExp(`<title>${brand.name}</title>`));
  });
});
