Feature: To test new API Endpoint

Scenario: Test new Endpoint
    * url "https://dummy.restapiexample.com/api/v1/create"
    * requestHeader '{"Content-Type":"application/json"}'
    * requestHeader '{"Content-Type1":"application/json"}'
    * requestBody "{'name':'test','salary':'123','age':'23'}"
    * method "POST"
     