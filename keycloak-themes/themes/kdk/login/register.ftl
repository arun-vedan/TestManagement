<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=messagesPerField.exists('global') displayRequiredFields=false; section>
  <#--
      WP-137 — the signup form.

      WHY THIS FILE EXISTS. The kdk theme declared `parent=base` and shipped no
      register.ftl, so registration fell through to Keycloak's base template.
      Base's register.ftl imports "template.ftl", which theme inheritance
      resolves to KDK's copy, so the page came out as base's plain
      <input class=""> markup wearing this theme's chrome: the most important
      page in a self-serve funnel was the least finished one.

      THIS FILE IS NOT WHAT MADE SIGNUP COLLECT A PASSWORD. Say so plainly,
      because the obvious reading of this file is that it added the password
      box and that is false. A completed signup used to produce an ENABLED
      account with ZERO credentials and an UPDATE_PASSWORD required action;
      the cause was the registration flow's `registration-password-action`
      config, whose `always_set_password_on_register_form` defaults to false
      whenever the realm has `verifyEmail` on. That is set by
      scripts/configure-keycloak-email.js, which carries the full argument and
      the trade-off. Turn it back off and the fields below correctly vanish.

      FIELDS COME FROM THE USER PROFILE, NOT A FIXED LIST. An earlier draft of
      this file hard-coded username/email/firstName/lastName as four Quasar
      inputs. That renders the realm's DEFAULT profile correctly and silently
      drops any attribute an admin adds later — a field that exists, is
      required by the server, and cannot be filled in, which is worse than an
      ugly field. So this loops `profile.attributes` exactly as base's
      user-profile-commons.ftl does, and only the PRESENTATION is Quasar's.
  -->
  <#if section = "header">
    <#if messageHeader??>${kcSanitize(msg("${messageHeader}"))?no_esc}<#else>${msg("registerTitle")}</#if>
  <#elseif section = "form">

    <#--
        Submitted values, for re-rendering after a validation error.

        The login page seeds its inputs from template.ftl's `#environment`
        block, which reads `user.*`. That is empty on this page: the register
        flow carries submitted values on `profile.attributes[].value`, not on
        `user`. Seeding from `#environment` would therefore have wiped
        everything the person typed every time the two passwords did not
        match — the single most likely error on this form.

        WHY ATTRIBUTES AND NOT A JSON BLOB. The obvious shape here is a
        <script type="application/json"> island. It is a trap, measured:
        Keycloak renders with FreeMarker's HTML auto-escaping on, so
        ?json_string's \" is then escaped again to \&quot; and the blob stops
        being parseable the moment anyone types a double quote. ?js_string is
        worse -- it emits \' , valid JS and invalid JSON -- and ?no_esc on
        either hands the page a way to break out of the <script> element.
        HTML-attribute escaping is the one path FreeMarker's auto-escaping
        gets exactly right, and .value/.dataset read it back already decoded,
        so O'Brien "Danger" \ survives without a hand-written escape anywhere.

        These carry no `name`, so they are not submitted; they only seed Vue.
    -->
    <div id="register-seed" hidden>
      <#list profile.attributes as attribute>
        <input type="hidden" data-field="${attribute.name}" value="${attribute.value!''}"/>
      </#list>
    </div>

    <div class="full-width">
      <q-form id="kc-register-form" action="${url.registrationAction}" method="post">

        <#list profile.attributes as attribute>
          <#if attribute.name == 'locale' && realm.internationalizationEnabled && locale.currentLanguageTag?has_content>
            <#-- Carried, not shown: base does the same. -->
            <input type="hidden" id="${attribute.name}" name="${attribute.name}" value="${locale.currentLanguageTag}"/>
          <#else>
            <#assign inputType = (attribute.annotations.inputType)!''>
            <#if inputType?starts_with('html5-')><#assign inputType = inputType[6..]></#if>
            <#if !inputType?has_content>
              <#-- type="email" over base's type="text" purely so a phone shows
                   the right keyboard; every other type honours the profile. -->
              <#assign inputType = (attribute.name == 'email')?then('email', 'text')>
            </#if>
            <#assign label = advancedMsg(attribute.displayName!'')>

            <div class="q-py-xs column">
              <q-input
                id="input-${attribute.name}"
                name="${attribute.name}"
                v-model="fields['${attribute.name}']"
                filled
                type="${inputType}"
                label="${label}<#if attribute.required> *</#if>"
                <#if attribute.autocomplete??>autocomplete="${attribute.autocomplete}"</#if>
                <#if attribute.readOnly>:disable="true"</#if>
                <#if (attribute.annotations.inputTypeMaxlength)??>maxlength="${attribute.annotations.inputTypeMaxlength}"</#if>
                :error="<#if messagesPerField.existsError('${attribute.name}')>true<#else>false</#if>"
                error-message="${kcSanitize(messagesPerField.getFirstError('${attribute.name}'))?no_esc}"
                :hide-bottom-space="true"
              />
            </div>

            <#--
                THE FIELDS THIS WP EXISTS FOR, in base's position: directly
                under whichever attribute acts as the login identifier.

                `passwordRequired` is NOT simply "is Password Validation in the
                flow". Measured: with that execution REQUIRED and the realm's
                verifyEmail on, the variable was still ABSENT, because
                `always_set_password_on_register_form` defaults to false and
                Keycloak then defers the password to a post-verification
                UPDATE_PASSWORD step.

                So this guard is load-bearing, not defensive boilerplate: it
                is the single switch deciding whether signup collects a
                password, and it must stay a guard rather than become
                unconditional — rendering these fields when Keycloak is not
                asking for a password gives the user two boxes the server
                throws away.
            -->
            <#if passwordRequired?? && (attribute.name == 'username' || (attribute.name == 'email' && realm.registrationEmailAsUsername))>
              <div class="q-py-xs column">
                <q-input
                  id="input-password" name="password" v-model="password" filled
                  label="${msg('password')} *" :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  <#-- Highlighted when EITHER field is at fault, because a
                       mismatch is a fault of the pair, but the message itself
                       is rendered once, under the confirm field. Measured:
                       keying both messages off both fields printed "Password
                       confirmation doesn't match." twice, stacked. -->
                  :error="<#if messagesPerField.existsError('password','password-confirm')>true<#else>false</#if>"
                  error-message="${kcSanitize(messagesPerField.getFirstError('password'))?no_esc}"
                  :hide-bottom-space="true"
                >
                  <template v-slot:append>
                    <q-icon :name="showPassword ? 'visibility' : 'visibility_off'" class="cursor-pointer"
                      @click="showPassword = !showPassword" />
                  </template>
                </q-input>
              </div>

              <div class="q-py-xs column">
                <q-input
                  id="input-password-confirm" name="password-confirm" v-model="passwordConfirm" filled
                  label="${msg('passwordConfirm')} *" :type="showPasswordConfirm ? 'text' : 'password'"
                  autocomplete="new-password"
                  :error="<#if messagesPerField.existsError('password-confirm')>true<#else>false</#if>"
                  error-message="${kcSanitize(messagesPerField.getFirstError('password-confirm'))?no_esc}"
                  :hide-bottom-space="true"
                >
                  <template v-slot:append>
                    <q-icon :name="showPasswordConfirm ? 'visibility' : 'visibility_off'" class="cursor-pointer"
                      @click="showPasswordConfirm = !showPasswordConfirm" />
                  </template>
                </q-input>
              </div>
            </#if>
          </#if>
        </#list>

        <#-- Terms, when the FLOW puts them on the form. This realm currently
             applies TERMS_AND_CONDITIONS as a post-registration required
             action instead, so this is normally inert; it is here so that
             moving terms into the flow does not silently drop them. -->
        <#if termsAcceptanceRequired??>
          <div class="q-py-sm column">
            <div class="text-caption q-pb-xs">${kcSanitize(msg("termsText"))?no_esc}</div>
            <#-- No :error prop -- QCheckbox has none; the message below is how
                 a terms failure surfaces. -->
            <q-checkbox id="input-termsAccepted" name="termsAccepted" v-model="termsAccepted"
              true-value="on" false-value="" label="${msg('acceptTerms')}" />
            <#if messagesPerField.existsError('termsAccepted')>
              <div class="text-negative text-caption">${kcSanitize(messagesPerField.get('termsAccepted'))?no_esc}</div>
            </#if>
          </div>
        </#if>

        <#if recaptchaRequired?? && (recaptchaVisible!false)>
          <div class="q-py-sm row justify-center">
            <div class="g-recaptcha" data-size="compact" data-sitekey="${recaptchaSiteKey}" data-action="${recaptchaAction}"></div>
          </div>
        </#if>

        <div class="row justify-center" :class="{ 'q-pa-sm': $q.screen.xs, 'q-pa-md': $q.screen.gt.xs }">
          <#if recaptchaRequired?? && !(recaptchaVisible!false)>
            <script>
              function onSubmitRecaptcha () { document.getElementById('kc-register-form').requestSubmit() }
            </script>
            <#-- Plain attributes, not Vue bindings: reCAPTCHA's script reads
                 these off the DOM, and a :binding of a literal only adds a
                 way to get the quoting wrong. -->
            <q-btn id="register-submit" type="submit" color="primary" no-caps
              class="g-recaptcha" data-sitekey="${recaptchaSiteKey}"
              data-callback="onSubmitRecaptcha" data-action="${recaptchaAction}"
              label="${msg('doRegister')}" />
          <#else>
            <q-btn id="register-submit" name="register" type="submit" color="primary" no-caps
              label="${msg('doRegister')}" :loading="registerLoading" @click="registerLoading = true" />
          </#if>
        </div>
      </q-form>
    </div>

    <#-- The return path. login.ftl offers "No account? Register", so without
         this the two pages are a one-way door. -->
    <div class="column items-center">
      <div class="row justify-center items-center">
        <q-btn id="back-to-login" label="${msg('backToLogin')?no_esc}" color="accent" flat rounded no-caps
          href="${url.loginUrl}" />
      </div>
    </div>

  <#elseif section = "socialProviders">
    <#--
        WP-138 — identity providers on the SIGNUP page.

        template.ftl's registrationLayout invokes <#nested "socialProviders">
        on every page, so without this branch the section simply rendered
        nothing here and the Google button appeared on sign-IN only — exactly
        backwards for a provider whose whole value is getting a NEW user in
        without a verification email.

        Kept deliberately identical in structure to login.ftl's block,
        including `?has_content`: Keycloak 26 leaves `social.providers`
        DEFINED but EMPTY when a realm has no identity providers, so a `??`
        test passes and renders a divider plus a heading above nothing. That
        was a real regression after the 25 -> 26 upgrade; it is recorded in
        login.ftl and must not be reintroduced here.

        Only the label differs — someone on this page is signing up, not
        signing in.
    -->
    <#if realm.password && social.providers?? && social.providers?has_content>
      <hr style="width: 75%" />
      <div
        class="column items-center"
        :class="{ 'q-pb-xs': $q.screen.xs, 'q-pb-sm': $q.screen.gt.xs }"
      >
        <div class="text-subtitle1">
          ${msg("identity-provider-register-label")}
        </div>
        <div class="q-pa-sm row justify-center">
          <#list social.providers as p>
            <q-btn id="social-${p.alias}" label="${p.displayName!}" color="accent" href="${p.loginUrl}" />
          </#list>
        </div>
      </div>
    </#if>
  </#if>
</@layout.registrationLayout>
