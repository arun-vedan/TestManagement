/* 
  Define the Quasar app using UMD version
  see https://quasar.dev/start/umd/#quasar-config-object
*/ 

// Create the Vue app
const app = Vue.createApp({
  setup () {
    // data
    const environment = JSON.parse(String(document.querySelector('#environment').textContent))
    let informations = null
    // WP-137 — the signup form's fields are whatever Keycloak's user profile
    // says they are, so they cannot be a fixed list of refs the way the login
    // form's are. register.ftl emits one seed input per profile attribute and
    // the q-inputs bind into this single reactive object by attribute name.
    //
    // Seeded from #register-seed rather than from `environment.user` because
    // the register flow carries submitted values on profile.attributes[].value,
    // leaving user.* empty; seeding from environment would blank everything
    // the person typed on a password mismatch, this form's likeliest error.
    //
    // Read from attributes, not a JSON island: see the comment in
    // register.ftl. Empty on every other page, which is why the form's
    // bindings are the only thing that touches it.
    const fields = Vue.reactive({})
    document.querySelectorAll('#register-seed input[data-field]').forEach((el) => {
      fields[el.dataset.field] = el.value
    })
    // functions
    function version () {
      return {
        theme: themeVersion,
        kdk: kdkVersion
      }
    }
    // WP-155 — `popup()` removed. It fetched resources/html/<name>_<locale>.html
    // to show a legal notice or data policy in a dialog. Those four files were
    // Kalisio's OWN legal notices, inherited verbatim when this theme was
    // vendored from their MIT-licensed keycloak-themes project (commit c29b185,
    // 2024-06-19) — they carried a French company's registered address, RCS
    // number and VAT number, and were publicly served from this login server.
    // Deleted, along with the legalNotice/dataPolicy message keys.
    //
    // Nothing ever called this function: no .ftl referenced it and no template
    // referenced those message keys, so it was dead on arrival. Left as a note
    // rather than silently gone, because when real terms exist they must be
    // SERVED somewhere a user can read them before accepting, and whoever does
    // that will look here first.

    // Expose 
    return {
      email: Vue.ref(environment.user.email),
      username: Vue.ref(environment.user.username),
      firstName: Vue.ref(environment.user.firstName),
      lastName: Vue.ref(environment.user.lastName),
      password: Vue.ref(''),  
      rememberMe: Vue.ref(environment.realm.rememberMe ? 'on' : 'off'),
      loginLoading: Vue.ref(false),
      resetPasswordLoading: Vue.ref(false),
      passwordNew: Vue.ref(''),
      passwordConfirm: Vue.ref(''),
      updatedPasswordLoading: Vue.ref(false),
      showPassword: Vue.ref(false),
      showPasswordNew: Vue.ref(false),
      showPasswordConfirm: Vue.ref(false),
      submitAction: Vue.ref(''),
      // WP-137 — signup
      fields,
      registerLoading: Vue.ref(false),
      termsAccepted: Vue.ref(''),
      version,
    }
  }
})

// Tell Vue to use Quasar using the specified configuration
app.use(Quasar, {
  config
})

// Mount the Quasar app
app.mount('#q-app')


