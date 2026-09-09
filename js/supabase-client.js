// Supabase 呼叫設定
const SUPABASE_URL = 'https://iqmlglpaxecqhssgghqj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxbWxnbHBheGVjcWhzc2dnaHFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODc0NDksImV4cCI6MjA4NjU2MzQ0OX0.4x8Z9jW6h7K3m5L2v1N0x9J8h7G6f5D4s3A2q1W0e9Q';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
