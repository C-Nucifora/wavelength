#include <Security/Security.h>

// LAContext does not suppress access dialogs for the legacy login keychain.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static inline OSStatus WavelengthSetKeychainInteractionAllowed(bool allowed) {
    return SecKeychainSetUserInteractionAllowed(allowed);
}
#pragma clang diagnostic pop
