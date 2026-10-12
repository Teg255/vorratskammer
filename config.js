// Verbindung zur gemeinsamen Datenbank (Firebase).
// Diese Werte sind nicht geheim: Sie stehen in jeder Firebase-Web-App im Klartext.
// Geschützt werden die Daten durch den Login und die Regeln in firestore.rules.
// Solange apiKey leer ist, läuft die App im Demo-Modus (Daten nur auf diesem Gerät).
window.VK_CONFIG = {
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: "",
  },
};
