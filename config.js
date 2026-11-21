// Pega aquí tu Client ID de Google Cloud (ver README.md, paso 1)
const CONFIG = {
  CLIENT_ID: '396183338434-oavtpl050l56o9gbtl37asflr7p0ev77.apps.googleusercontent.com',
  // Opcional: nombre de la carpeta de Drive donde está tu música.
  // Si lo dejas vacío, la app busca audios en todo tu Drive.
  FOLDER_NAME: 'Mi Música',
  // Para compartir TU carpeta con otras personas: pega aquí el ID de la carpeta.
  // Es la parte final de la dirección al abrirla en Drive:
  // drive.google.com/drive/folders/ESTE_ES_EL_ID
  // Si lo llenas, tiene prioridad sobre FOLDER_NAME.
  FOLDER_ID: '1QzQZznIE80ldoov8kJXJVn6N2vJWqM6C',
  // Guarda las listas y favoritas de cada persona en su propia cuenta de Google.
  // Ponlo en false si quieres desactivarlo (se guardarán solo en cada celular).
  CLOUD_SYNC: true
};
