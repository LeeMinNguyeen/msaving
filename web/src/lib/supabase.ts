import { createClient } from '@supabase/supabase-js'
import { config } from '../config'

// Sign-in only. Data always goes through the API, never Supabase's Data API.
export const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey)
