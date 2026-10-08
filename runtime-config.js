// Public frontend settings. Never put API keys or server access tokens here.
window.TEXTLENS_CONFIG = {
  backendUrl: ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    ? ''
    : 'https://72-61-224-90.sslip.io',
};
