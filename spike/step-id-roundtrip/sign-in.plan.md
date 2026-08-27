profile: test
title: user can sign in
file: user-can-sign-in
next_id: s6
---
## steps

- id: s1
  action: go to the login page
  locator: none
  value: literal '/'
- id: s2
  action: fill the email field
  locator: getByLabel('Email')
  value: env:E2E_USER
  reason: label present on the form
- id: s3
  action: fill the password field
  locator: getByLabel('Password')
  value: literal 'correct horse'
  reason: label present on the form
- id: s4
  action: submit the form
  locator: getByRole('button', { name: 'Sign in' })
  reason: role=button, name="Sign in"
- id: s5
  action: assert the dashboard heading is shown
  locator: getByRole('heading', { name: 'Dashboard' })
  expect: visible
  reason: role=heading
