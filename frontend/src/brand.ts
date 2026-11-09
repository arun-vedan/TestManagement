// The one place the product's customer-visible identity lives. Internal
// identifiers (Mongo databases, the Keycloak realm `srckube`,
// @srckube/service-core, container names) deliberately stay `srckube` --
// renaming them is a data migration, not a rebrand. Colours live in
// Theme/tokens.ts; this file is names, copy and asset paths.
export const brand = {
  name: 'vedan',
  tagline: 'Hunt down the bugs.',
  descriptor: 'End-to-end testing, simplified',
  domain: 'vedan.io',
  supportEmail: 'admin@vedan.io',
  assets: {
    // Head-and-shoulders crop of the archer mascot, for small square slots.
    mark: '/images/vedan/mark.png',
    wordmark: '/images/vedan/wordmark.png',
    wordmarkOnDark: '/images/vedan/wordmark-white.png',
    // The full brand sheet with its background removed.
    sheet: '/images/vedan/vedan-full-900.png',
  },
} as const;
