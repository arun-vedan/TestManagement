import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// WP-074 -- Quill's stylesheet is imported here, at the app entry, rather
// than from a component. It was previously a side effect of
// Components/Tabs/TabContent.tsx being in the bundle, and that file is
// deleted by WP-078; every ReactQuill consumer (the workbench's
// detail/FieldGrid, DefectContent, TestExecutionContent) would then have
// rendered unstyled, with no test to catch it since CSS is not asserted.
// The entry point is also the one place jest never loads in component
// tests, so importing it here cannot break their transforms.
import 'react-quill/dist/quill.snow.css';
import App from './App';
import keycloak from './keycloak';


keycloak.init({ onLoad: 'login-required' }).then(authenticated => {
  if (authenticated) {
    
    const root = ReactDOM.createRoot(
      document.getElementById('root') as HTMLElement
    );
    root.render(
      
        <App />
      
    );
  } else {
    console.warn('User is not authenticated');
  }
}).catch(error => {
  console.error('Keycloak initialization failed:', error);
});

