-- =============================================
-- SnapGen Video Automation - Supabase Schema
-- =============================================
-- Copy this into Supabase SQL Editor
-- =============================================

CREATE TABLE IF NOT EXISTS public.video_jobs (
    id              TEXT PRIMARY KEY,
    prompt          TEXT NOT NULL,
    model           TEXT DEFAULT 'veo',
    ratio           TEXT DEFAULT '16:9',
    quality         TEXT DEFAULT '1080p',
    duration        INTEGER DEFAULT 8,
    status          TEXT DEFAULT 'queued',
    video_url       TEXT,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_status CHECK (status IN ('queued', 'processing', 'completed', 'error'))
);

ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access" ON public.video_jobs FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.video_jobs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON public.video_jobs FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow public delete" ON public.video_jobs FOR DELETE USING (true);

CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON public.video_jobs(status);
CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON public.video_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status_created ON public.video_jobs(status, created_at DESC);
