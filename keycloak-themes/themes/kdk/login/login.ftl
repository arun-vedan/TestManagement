<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
  <!--
      Form section
  -->
  <#if section = "form">
    <#if realm.password>

      <#-- The form's own title is omitted deliberately: template.ftl's
           sign-in panel already carries a heading, and rendering
           loginAccountTitle here as well produced two stacked titles
           ("Sign in" above "Sign in to your account"). -->
      <!-- Content -->
      <div class="full-width">
        <q-form action="${url.loginAction}" method="post">
          <#if !usernameHidden??>
            <div class="q-py-xs column">
              <q-input 
                id="input-username" name="username" v-model="email" filled
                label="<#if !realm.loginWithEmailAllowed>${msg('username')}<#elseif !realm.registrationEmailAsUsername>${msg('usernameOrEmail')}<#else>${msg('email')}</#if>"
                type="<#if !realm.loginWithEmailAllowed>text<#elseif !realm.registrationEmailAsUsername>text<#else>mail</#if>" 
                :error="<#if messagesPerField.existsError('username','password')>true<#else>false</#if>"
                error-message="${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}"
                :hide-bottom-space="true"
              />
            </div>
          </#if>
          <div class="q-py-xs column">
            <q-input 
              id="input-password" name="password" v-model="password" label="${msg('password')}" filled :type="showPassword ? 'text' : 'password'" autocomplete="off" 
              :error="<#if usernameHidden?? && messagesPerField.existsError('username')>true<#else>false</#if>"
              error-message="${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}"
              :hide-bottom-space="true"
            >
              <template v-slot:append>
                <q-icon :name="showPassword ? 'visibility' : 'visibility_off'" class="cursor-pointer" @click="showPassword = !showPassword" />
              </template>
            </q-input>
          </div>
          <!-- Options -->
          <div class="row justify-between items-center no-wrap">
            <#if realm.rememberMe && !usernameHidden??>
              <div>
                <q-toggle id="remember-me" name="rememberMe" v-model="rememberMe" false-value="off" true-value="on" label="${msg('rememberMe')}" />
              </div>
            </#if>
            <#if realm.resetPasswordAllowed>
              <div>
                <q-btn id="reset-password" label="${msg('doForgotPassword')}" color="accent" flat rounded no-caps href="${url.loginResetCredentialsUrl}" />
              </div>
            </#if>
          </div>
          <!-- Submit actions -->
          <div 
            class="row justify-center"
            :class="{ 'q-pa-sm': $q.screen.xs, 'q-pa-md': $q.screen.gt.xs }"
          >
            <q-btn id="login" name="login" label="${msg('doLogin')}" color="primary" :loading="loginLoading" @click="loginLoading = true" type="submit" />
          </div>
        </q-form>
      </div>
      <!-- Extra actions -->
      <div class="column items-center">
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
          <div class="row justify-center items-center">
            <span>${msg('noAccount')}</span>
            <q-btn id="register" label="${msg('doRegister')}" color="accent" flat rounded no-caps href="${url.registrationUrl}" />
          </div>
        </#if>
      </div>
    </#if>
  <!--
      SocialProviders sections
  -->
  <#elseif section = "socialProviders" >
    <#-- Keycloak 26 leaves `social.providers` DEFINED but EMPTY when a realm
         has no identity providers, so the old `social.providers??` test passed
         and rendered a divider plus "Or sign in with" above nothing. Surfaced
         immediately after the 25 -> 26 upgrade. `?has_content` is the check
         that actually means "there is something to show". -->
    <#if realm.password && social.providers?? && social.providers?has_content>
      <hr style="width: 75%" />
      <div 
        class="column items-center"
        :class="{ 'q-pb-xs': $q.screen.xs, 'q-pb-sm': $q.screen.gt.xs }"
      >
        <div class="text-subtitle1">
            ${msg("identity-provider-login-label")}
        </div>
        <div class="q-pa-sm row jsutify-center">
          <#list social.providers as p>
            <q-btn label="${p.displayName!}" color="accent" href="${p.loginUrl}" />
          </#list>
        </div>
      </div>
    </#if>
  </#if>
</@layout.registrationLayout>
