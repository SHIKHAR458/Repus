const CLIENT_ID_KEY = 'repus.clientId';

export const getClientId = () => {
  const existingId = window.sessionStorage.getItem(CLIENT_ID_KEY);
  if (existingId) return existingId;

  const clientId = crypto.randomUUID();
  window.sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
};
