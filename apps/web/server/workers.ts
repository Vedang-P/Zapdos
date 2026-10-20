/**
 * Combined background-worker process for the Render realtime service.
 *
 * The free Render instance has 512 MB of RAM, so running matchmaker, finalizer,
 * and bot as three separate Node processes wastes memory. They are independent
 * polling loops, so importing them into one process is safe.
 */

import './matchmaker';
import './finalizer';
import './bot-worker';
