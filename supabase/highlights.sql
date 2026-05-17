-- Storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('highlights', 'highlights', true, 104857600)  -- 100MB limit
ON CONFLICT (id) DO NOTHING;

-- Highlights metadata
CREATE TABLE IF NOT EXISTS highlights (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'general',  -- 'bad_beat','big_win','bluff','funny','general'
  video_url   TEXT,
  storage_path TEXT,
  thumbnail_url TEXT,
  uploaded_by UUID REFERENCES users(id),
  uploader_username TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  likes_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS highlight_likes (
  highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id),
  PRIMARY KEY (highlight_id, user_id)
);

CREATE TABLE IF NOT EXISTS highlight_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id),
  username     TEXT NOT NULL,
  comment      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
