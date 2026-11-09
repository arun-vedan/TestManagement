# Keycloak themes

The Keycloak login theme vedan serves. Realm `srckube` has `loginTheme: kdk`, and
`frontend/src/keycloak.js` drives that realm with `onLoad: 'login-required'`, so
**these templates are the sign-in and sign-up UI** — not decoration. A change here
is a change to the only page an unauthenticated visitor sees.

## Attribution and licence — read before deleting anything

This directory is **derived from [Kalisio](https://kalisio.com)'s MIT-licensed
`keycloak-themes` project**, vendored wholesale in commit `c29b185`
(2024-06-19). The `kdk` theme is theirs ("KDK" = Kalisio Development Kit), built
on the Quasar Framework; `kapp` is their example theme and overrides only a logo.

**`LICENSE` must stay, with Kalisio's copyright line intact.** MIT permits
everything we do with this — commercial use, modification, rebranding, renaming —
on one condition: the copyright notice and permission notice travel with the
copies. Deleting that file during a rebrand sweep would turn a clean, compliant
reuse into a licence breach. It is the one file in here that is not ours to tidy.

What *was* removed, deliberately: `themes/kdk/login/resources/html/` held
Kalisio's **own** legal notice and data policy in English and French, carrying a
French company's registered address, RCS number and VAT number. Those were
publicly served from this login server at
`/resources/<hash>/login/kdk/html/*.html` and are gone, along with the
`legalNotice` / `dataPolicy` message keys and the `popup()` helper in `quasar.js`
that fetched them. Nothing referenced any of it — it was dead on arrival from the
fork — but serving another company's tax registration is not something to leave
lying around. Our own legal copy is tracked under WP-155 and does not exist yet.

`kdkThemeVersion` remains in the message bundles and `kdkVersion` in
`theme.properties`; both are version strings read by `template.ftl`, not brand or
legal content.

## Layout

```
themes/kdk/login/       the theme actually in use
  template.ftl          registrationLayout; emits #environment and invokes the
                        "form" and "socialProviders" sections on EVERY page
  login.ftl             sign-in, plus the identity-provider buttons
  register.ftl          sign-up (WP-137/WP-138)
  login-*.ftl           reset password, update password, update profile
  fragments/            banner, header, footer, options
  messages/             messages_en + messages_fr — theme.properties declares
                        locales=fr,en, so a key added to one needs the other
  resources/js/quasar.js  the Vue app; its exposed refs are what the .ftl files bind to
themes/kapp/            Kalisio's example theme; parent=kdk, overrides a logo only
```

## Things in here that look cosmetic and are not

Learned the hard way; see `EXECUTION_LOG.md` for the measurements behind each.

- **`register.ftl`'s `<#if passwordRequired??>` guard** decides whether signup
  collects a password at all. It depends on the realm's
  `always_set_password_on_register_form`, which lives only in Postgres. Guarded by
  `backend/userService/__tests__/signupCollectsPassword.test.js`.
- **`social.providers?has_content`**, in both `login.ftl` and `register.ftl`. The
  `??` form is not equivalent: Keycloak 26 leaves that variable *defined but
  empty*, so `??` renders a divider and "Or sign in with" above nothing.
- **`template.ftl`'s `<#nested "socialProviders">`.** Remove it and the
  identity-provider buttons vanish from both pages with no error anywhere.
- **`#environment`**, emitted by `template.ftl` and `JSON.parse`d by `quasar.js`.
  Break its shape and every login page throws.
- **`#register-seed`** repopulates the signup form after a validation error using
  HTML attributes, not a JSON island — deliberately. Keycloak renders with
  FreeMarker's HTML auto-escaping on, so `?json_string`'s `\"` is escaped again to
  `\&quot;` and a JSON blob stops parsing the moment anyone types a double quote.

## Local development

The theme is bind-mounted and Keycloak runs with template and theme caching off
(`keycloak-themes/docker-compose.yml`), so an edit here takes effect on the next
page load — no rebuild, no restart. A FreeMarker error surfaces as HTTP 500 with
the failing expression and line number in `docker logs keycloak`.

If the theme directory is ever renamed, the realm's `loginTheme` must be updated
to match. Keycloak silently falls back to the base theme otherwise: the pages
keep working, they just stop being ours.
