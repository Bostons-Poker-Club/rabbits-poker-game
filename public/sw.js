self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {
  self.clients.matchAll({includeUncontrolled: true}).then(clients => {
    clients.forEach(client => client.navigate(client.url));
  });
});
