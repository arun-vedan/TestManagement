<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html <#if realm.internationalizationEnabled>lang="${locale.currentLanguageTag}"</#if>>

<head>
  <link href="https://fonts.googleapis.com/css?family=Roboto:100,300,400,500,700,900|Material+Icons" rel="stylesheet" type="text/css">
  <link href= "https://maxst.icons8.com/vue-static/landings/line-awesome/line-awesome/1.3.0/css/line-awesome.min.css" rel= "stylesheet" type="text/css">
  <link href="https://cdn.jsdelivr.net/npm/quasar@2.14.1/dist/quasar.prod.css" rel="stylesheet" type="text/css">
  <meta charset="utf-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="robots" content="noindex, nofollow">

  <#if properties.meta?has_content>
    <#list properties.meta?split(' ') as meta>
      <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
    </#list>
  </#if>
  <title>${msg("loginTitle",(realm.displayName!''))}</title>
  <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
  <link rel="stylesheet" href="${url.resourcesPath}/css/login.css" />
  <#if properties.stylesCommon?has_content>
    <#list properties.stylesCommon?split(' ') as style>
      <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
    </#list>
  </#if>
  <#if properties.styles?has_content>
    <#list properties.styles?split(' ') as style>
      <link href="${url.resourcesPath}/css/${style}" rel="stylesheet" />
    </#list>
  </#if>
  <#if properties.scripts?has_content>
    <#list properties.scripts?split(' ') as script>
      <script src="${url.resourcesPath}/js/${script}" type="text/javascript"></script>
    </#list>
  </#if>
  <#if properties.version?has_content>
    <script>
      const themeVersion = '${properties.version}'
    </script>
  <#else>
    <script>
      const themeVersion = undefined
    </script>
  </#if>
  <#if properties.kdkVersion?has_content>
    <script>
      const kdkVersion = '${properties.kdkVersion}'
    </script>
  <#else>
    <script>
      const kdkVersion = undefined
    </script>      
  </#if>
</head>

<body>
  <div id="q-app">
    <!--
      Two-panel layout: brand story on the LEFT, sign-in form on the RIGHT.
      Replaces the single 600px card marooned on a flat grey field. The page
      background is the brand anchor #084C32 (frontend/src/Theme/tokens.ts),
      so the first screen a user sees matches the product they are signing
      into. The brand panel is a light tint, not the anchor: the vedan
      artwork's wordmark is Deep Forest and vanishes on a dark panel. Stacks to a single column under 900px -- see resources/css/login.css.
    -->
    <div class="sk-shell row items-center justify-center q-pa-md">
      <div class="sk-split row items-stretch">

        <!-- Brand panel (decorative + product framing) -->
        <div class="sk-panel-brand col-12 col-md-6 column justify-center">
          <#include "fragments/banner.ftl">
          <h1>Hunt down the bugs.</h1>
          <p>Requirements, test cases, plans, runs and defects — linked, so every failure leads back to what it broke.</p>
          <img class="sk-illus" src="${url.resourcesPath}/img/vedan-sheet.png"
               alt="The vedan mascot, an archer, tracking bugs with a magnifier, chasing them with a net, and celebrating on a green checkmark"/>
        </div>

        <!-- Sign-in panel -->
        <div class="sk-panel-form col-12 col-md-6 column justify-center">
          <div class="sk-form-title">Sign in</div>
          <div class="sk-form-sub">Use your vedan account to continue.</div>
          <#nested "form">
          <#nested "socialProviders">
          <div class="q-pt-sm">
            <#include "fragments/options.ftl">
          </div>
        </div>

      </div>
    </div>
  </div>
  <!--
    Retrieve Keycloak environement
  -->
  <script id="environment" type="application/json">
    {
      "realm": {
        "resourcesPath": "${url.resourcesPath}",
        "i18n": {
          "enabled": <#if realm.internationalizationEnabled>true<#else>false</#if>,
          "locale": <#if realm.internationalizationEnabled>"${locale.currentLanguageTag}"<#else>null</#if>
        },
        "rememberMe": <#if realm.rememberMe>true<#else>false</#if>
      },
      "user": {
        "username": <#if user??>"${(user.username!'')}"<#else>""</#if>,
        "email": <#if user??>"${(user.email!'')}"<#else>""</#if>,
        "firstName": <#if user??>"${(user.firstName!'')}"<#else>""</#if>,
        "lastName": <#if user??>"${(user.lastName!'')}"<#else>""</#if>
      }
    }
  </script>
  <!-- 
    Use Vue and Quasar with UMD version
    For more information, refer to https://quasar.dev/start/umd#installation
  -->
  <script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/quasar@2.14.1/dist/quasar.umd.prod.js"></script>
  <!-- Install Quasar language pack -->
  <#if realm.internationalizationEnabled>
    <#if properties.locales?has_content>
      <#list properties.locales?split(',') as locale>
        <script src="https://cdn.jsdelivr.net/npm/quasar@2.14.1/dist/lang/${locale}.umd.prod.js"></script>
      </#list>      
    </#if>
    <script>Quasar.lang.set(Quasar.lang.${locale.currentLanguageTag})</script>
  </#if>
  <script src="${url.resourcesPath}/js/config.js"></script>
  <script src="${url.resourcesPath}/js/quasar.js"></script>
</body>
</html>
</#macro>