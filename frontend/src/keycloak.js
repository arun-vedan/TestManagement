import Keycloak from 'keycloak-js';

const keycloak = new Keycloak({
  url: process.env.REACT_APP_KEYCLOAK_BASE_URL,
  realm: 'srckube',
  clientId: 'mern-app'
});

export default keycloak;