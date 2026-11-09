<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#--
      WP-155 — the terms gate, styled.

      WHY THIS FILE EXISTS. The kdk theme shipped no terms.ftl, so this page
      fell through to Keycloak's base template: unstyled `<input
      class="">` buttons against a login and signup page built from Quasar
      components, and base's own `termsText`, which reads literally
      "Terms and conditions to be defined".

      This is not a page anyone chose to show. TERMS_AND_CONDITIONS became a
      realm DEFAULT required action in WP-130, so Keycloak puts it in front of
      every newly created account. Every user created since has been asked to
      accept that placeholder, and the e2e suite
      (specs/termsAcceptance.spec.ts) asserts the gate works without asserting
      the copy, precisely so this gap could not be mistaken for finished.

      WHAT IS AND IS NOT FIXED HERE. The plumbing is: the page is styled, the
      buttons post what Keycloak expects, and the text comes from the message
      bundles so both locales work. The COPY is owner-supplied and still
      incomplete — see messages_en.properties, where the remaining gaps are
      marked. Until they are filled this page says so plainly rather than
      pretending, because a user who accepts terms that do not exist has
      agreed to nothing and the acceptance is worth nothing.

      THE TWO FIELD NAMES ARE LOAD-BEARING. Keycloak's
      TermsAndConditions required action reads `accept` and `cancel` off the
      POST body (not the button labels, which are localised). Rename either
      and the page still renders, still submits, and silently never clears the
      required action — an infinite loop back to this screen. They match
      base/login/terms.ftl deliberately.
  -->
  <#if section = "header">
    ${msg("termsTitle")}
  <#elseif section = "form">
    <div class="full-width">
      <#-- kcSanitize + ?no_esc: the message is HTML by design (base's own
           default is a <p>), so it must not be escaped, but it is also
           rendered unauthenticated to anyone who reaches signup, so it is
           sanitised first. Both halves matter. -->
      <div id="kc-terms-text" class="q-pb-md" style="max-height: 45vh; overflow-y: auto;">
        ${kcSanitize(msg("termsText"))?no_esc}
      </div>

      <#--
          PLAIN <input type="submit">, NOT <q-btn>. This is deliberate and was
          measured, because the Quasar version looked right and was wrong.

          Keycloak's TermsAndConditions action decides by presence:
          `getDecodedFormParameters().containsKey("cancel")` means declined,
          anything else means accepted (verified against the compiled class in
          keycloak-services 26.7.3). With two q-btn components in the form,
          clicking Accept posted a body that contained `cancel`, so the server
          recorded a DECLINE and bounced the browser to
          `#error=access_denied&error_description=termsAndConditionsDeclined`.
          The page looked correct, the button looked clicked, and consent was
          silently inverted.

          A Vue component has no business in the submit path of an auth form.
          These inputs submit the same name/value pairs base/login/terms.ftl
          does, need no JavaScript at all, and still work if Vue or the CDN
          fails to load -- which on the one page a user cannot get past is
          worth more than matching the button styling exactly.

          `value` is set explicitly rather than left to the label: a <button>
          with no value posts an empty string, and the pair this server reads
          should not depend on that subtlety.

          Accept is primary, Decline is present and real rather than hidden or
          styled as a trap -- a gate with no way to refuse is not consent.
      -->
      <form id="kc-terms-form" action="${url.loginAction}" method="POST">
        <div class="row justify-center q-gutter-sm" :class="{ 'q-pa-sm': $q.screen.xs, 'q-pa-md': $q.screen.gt.xs }">
          <input
            id="kc-accept"
            name="accept"
            type="submit"
            value="${msg('doAccept')}"
            class="q-btn q-btn-item non-selectable no-outline q-btn--standard q-btn--rectangle bg-primary text-white q-btn--actionable q-focusable q-hoverable q-px-md q-py-sm"
          />
          <input
            id="kc-decline"
            name="cancel"
            type="submit"
            value="${msg('doDecline')}"
            class="q-btn q-btn-item non-selectable no-outline q-btn--flat q-btn--rectangle text-negative q-btn--actionable q-focusable q-hoverable q-px-md q-py-sm"
          />
        </div>
      </form>
    </div>
  </#if>
</@layout.registrationLayout>
