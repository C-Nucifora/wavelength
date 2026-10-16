#!/bin/sh
if [ -n "$WAVELENGTH_TEST_HELPER_PID" ]; then
  printf '%s' "$$" > "$WAVELENGTH_TEST_HELPER_PID"
  exec /bin/sleep 30
fi
printf '%s' '{"ok":true,"result":{"platform":"fixture","running":false,"accessibility":false,"automation":"unknown","message":"Bundled helper selected"}}'
