import Foundation

enum WrapperCapture {
    static let observer = #"""
    (() => {
      const w = window;
      if (w !== w.top || w.location.protocol !== 'https:' || w.location.hostname !== 'music.apple.com' || (w.location.port && w.location.port !== '443') || w.__wavelengthCapture) return;
      let generation = null;
      const originalFetch = w.fetch;
      const proto = w.XMLHttpRequest.prototype;
      const originalOpen = proto.open, originalHeader = proto.setRequestHeader, originalSend = proto.send;
      const requestURL = Object.getOwnPropertyDescriptor(Request.prototype, 'url').get;
      const requestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, 'headers').get;
      const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get;
      const headerGet = Headers.prototype.get;
      const headerIterator = Object.getOwnPropertyDescriptor(Headers.prototype, Symbol.iterator).value;
      const requests = new WeakMap();
      const trusted = input => {
        try {
          const u = new URL(input, w.location.href);
          return u.protocol === 'https:' && u.hostname === 'amp-api.music.apple.com' && (!u.port || u.port === '443') && !u.username && !u.password;
        } catch (_) { return false; }
      };
      const emit = headers => {
        if (!generation) return;
        const bearer = headers.get('authorization'), user = headers.get('media-user-token');
        if (bearer && user && bearer.length <= 16384 && user.length <= 16384) {
          try { w.webkit.messageHandlers.wavelengthCapture.postMessage({bearer, user, generation}); } catch (_) {}
        }
      };
      const passiveHeaders = value => {
        // Never consume iterables or invoke caller accessors to inspect a request.
        try {
          if (Object.getPrototypeOf(value) === Headers.prototype && Object.getOwnPropertyNames(value).length === 0 && Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyDescriptor(Headers.prototype, Symbol.iterator).value === headerIterator) {
            const bearer = headerGet.call(value, 'authorization'), user = headerGet.call(value, 'media-user-token');
            return new Headers([['authorization', bearer || ''], ['media-user-token', user || '']]);
          }
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== null) return null;
          const descriptors = Object.getOwnPropertyDescriptors(value);
          if (Object.getOwnPropertySymbols(descriptors).length) return null;
          const snapshot = {};
          for (const name of Object.keys(descriptors)) {
            const descriptor = descriptors[name];
            if (!descriptor.enumerable) continue;
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
            Object.defineProperty(snapshot, name, {value: descriptor.value, enumerable: true});
          }
          return new Headers(snapshot);
        } catch (_) { return null; }
      };
      const wrappedFetch = function(input, init) {
        // Fetch converts HeadersInit first. Observation must not change that conversion.
        const result = originalFetch.apply(this, arguments);
        try {
          let url = typeof input === 'string' ? input : null;
          if (!url) { try { url = requestURL.call(input); } catch (_) { try { url = urlHref.call(input); } catch (_) {} } }
          if (generation && url && trusted(url)) {
            let headers;
            if (init !== undefined && init !== null) {
              const prototype = Object.getPrototypeOf(init);
              if (prototype !== Object.prototype && prototype !== null) return result;
              const descriptor = Object.getOwnPropertyDescriptor(init, 'headers');
              if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return result;
              if (descriptor && descriptor.value !== undefined) headers = passiveHeaders(descriptor.value);
              else if (prototype === null || !Object.getOwnPropertyDescriptor(Object.prototype, 'headers')) { try { headers = passiveHeaders(requestHeaders.call(input)); } catch (_) {} }
            } else { try { headers = passiveHeaders(requestHeaders.call(input)); } catch (_) {} }
            if (headers) emit(headers);
          }
        } catch (_) {}
        return result;
      };
      const wrappedOpen = function(method, url) {
        const result = originalOpen.apply(this, arguments);
        requests.set(this, {trusted: typeof url === 'string' && trusted(url), headers: new Headers()});
        return result;
      };
      const wrappedHeader = function(name, value) {
        const result = originalHeader.apply(this, arguments);
        try {
          const state = requests.get(this);
          if (state && (typeof name !== 'string' || typeof value !== 'string')) state.trusted = false;
          else if (state && /^(authorization|media-user-token)$/i.test(name)) state.headers.append(name, value);
        } catch (_) {}
        return result;
      };
      const wrappedSend = function() {
        try { const state = requests.get(this); if (state && state.trusted) emit(state.headers); } catch (_) {}
        return originalSend.apply(this, arguments);
      };
      w.fetch = wrappedFetch; proto.open = wrappedOpen; proto.setRequestHeader = wrappedHeader; proto.send = wrappedSend;
      w.__wavelengthCapture = {
        start: value => { if (typeof value === 'string' && value.length <= 64) generation = value; },
        stop: () => {
          generation = null;
          if (w.fetch === wrappedFetch) w.fetch = originalFetch;
          if (proto.open === wrappedOpen) proto.open = originalOpen;
          if (proto.setRequestHeader === wrappedHeader) proto.setRequestHeader = originalHeader;
          if (proto.send === wrappedSend) proto.send = originalSend;
          delete w.__wavelengthCapture;
        }
      };
    })();
    """#
    static let getter = #"""
    (() => {
      if (window !== window.top || location.protocol !== 'https:' || location.hostname !== 'music.apple.com') return null;
      try {
        const m = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
        if (!m) return null;
        const out = {};
        if (typeof m.developerToken === 'string' && m.developerToken.length <= 16384) out.bearer = m.developerToken;
        if (typeof m.musicUserToken === 'string' && m.musicUserToken.length <= 16384) out.user = m.musicUserToken;
        return out;
      } catch (_) { return null; }
    })();
    """#
}
