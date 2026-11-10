# woori-meeting-room

`https://woori-meeting-room.kro.kr/` 화면을 그대로 옮긴 Vercel 배포용 프로젝트.

- `views/index.html` — 원본 화면 (수정 없음). `api/page.ts`가 접속 코드 확인 후 내려준다. `POST /api/<함수명>` RPC를 호출한다.
- `api/[fn].ts` — RPC 진입점. 조회는 Runtime Cache, 쓰기는 Neon 직접.
- `lib/handlers.ts` — API 13개. 중복 예약은 DB 배타 제약(`lib/schema.sql`)이 최종 방어선.
- `scripts/import-from-live.ts` — 기존 사이트 공개 API에서 구성원·예약 가져오기.

## 로컬
```bash
npm install
npx tsx scripts/import-from-live.ts   # data/pg 에 로컬 PGlite로 적재 (DATABASE_URL 없을 때)
npx tsx scripts/dev-server.ts         # http://localhost:3100  (접속 코드 9999, 관리자 비번 dev-admin)
npm test
```

## 배포 (아직 안 함)
1. Neon 프로젝트 생성(이 서비스 전용) → `DATABASE_URL`
2. Vercel 환경변수: `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ACCESS_CODE`(=9999)
3. `DATABASE_URL=... npx tsx scripts/import-from-live.ts` 로 스키마 생성 + 이력 적재
4. `vercel --prod`

## 원본과 다른 점 / 확인 필요
- 가져온 예약의 수정·취소 PIN은 전부 `1234`로 통일했다 (원본 PIN은 못 받음, `IMPORT_PIN`으로 변경 가능).
- 사이트 입장 시 접속 코드(`ACCESS_CODE`)를 한 번 입력하면 30일간 쿠키로 유지된다. 화면과 API 모두 막는다.
- 공개 API에 노출되던 전화번호는 가져오지 않고 응답에서도 뺐다.
- 원본 서버 내부 규칙(지난 시간 처리, 검색 범위 등)은 화면 동작으로 추정해 구현. 취소 이력·참석자는 DB를 직접 받아야 이관 가능.
