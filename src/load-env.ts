import { config } from 'dotenv';
import { join } from 'path';

/** Carga `backend/.env` al correr desde `dist/` (`__dirname` = .../dist). */
const envPath = join(__dirname, '..', '.env');
config({ path: envPath });
/** Por si ejecutás el proceso con cwd = `backend/` y el .env está ahí. */
config();
