CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS rooms (
  room_id   text PRIMARY KEY,
  name      text NOT NULL,
  floor     int  NOT NULL,
  direction text NOT NULL,
  capacity  int  NOT NULL,
  color     text NOT NULL,
  sort      int  NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  member_id  text PRIMARY KEY,
  name       text NOT NULL,
  department text NOT NULL DEFAULT '',
  company    text NOT NULL DEFAULT '',
  work_floor text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id   text PRIMARY KEY,
  group_id         text NOT NULL,
  repeat_type      text NOT NULL DEFAULT 'NONE',
  room_id          text NOT NULL REFERENCES rooms(room_id),
  date             date NOT NULL,
  start_min        int  NOT NULL CHECK (start_min >= 480 AND start_min < 1200),
  end_min          int  NOT NULL CHECK (end_min > start_min AND end_min <= 1200),
  booker_name      text NOT NULL,
  booker_member_id text NOT NULL DEFAULT '',
  attendees        jsonb NOT NULL DEFAULT '[]',
  booker_attends   boolean NOT NULL DEFAULT true,
  meeting_title    text NOT NULL DEFAULT '',
  vp_attends       boolean NOT NULL DEFAULT false,
  pin_hash         text,
  request_id       text,
  status           text NOT NULL DEFAULT 'ACTIVE',
  cancel_reason    text NOT NULL DEFAULT '',
  cancelled_by     text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- 같은 방·같은 날 겹치는 시간대는 DB가 거절한다. 동시 요청 경쟁을 앱 코드가 아니라 제약으로 막기 위함.
  CONSTRAINT no_overlap EXCLUDE USING gist (
    room_id WITH =, date WITH =, int4range(start_min, end_min) WITH &&
  ) WHERE (status = 'ACTIVE')
);

CREATE INDEX IF NOT EXISTS reservations_date_idx ON reservations (date) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS reservations_group_idx ON reservations (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_request_uq
  ON reservations (request_id, room_id, date) WHERE request_id IS NOT NULL;
