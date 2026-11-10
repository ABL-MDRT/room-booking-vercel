import { getCache } from '@vercel/functions';

export interface Cache {
  wrap<T>(key: string, tags: string[], ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  expire(tags: string[]): Promise<void>;
}

export const noCache: Cache = {
  wrap: (_key, _tags, _ttl, load) => load(),
  expire: async () => {},
};

/**
 * 조회 결과를 Vercel Runtime Cache에 둔다. 캐시 장애가 예약 기능을 막으면 안 되므로
 * 읽기·쓰기 오류는 로그만 남기고 DB 조회로 넘어간다.
 * 중복 예약 검사는 항상 DB를 직접 보기 때문에 오래된 캐시가 이중 예약을 만들지는 않는다.
 */
export function vercelCache(): Cache {
  const cache = getCache();
  return {
    async wrap(key, tags, ttlSeconds, load) {
      try {
        const hit = await cache.get(key);
        if (hit !== null && hit !== undefined) return hit as never;
      } catch (err) {
        console.error(`캐시 읽기 실패 key=${key}:`, err);
      }
      const value = await load();
      try {
        await cache.set(key, value, { ttl: ttlSeconds, tags });
      } catch (err) {
        console.error(`캐시 쓰기 실패 key=${key}:`, err);
      }
      return value;
    },
    async expire(tags) {
      try {
        await cache.expireTag(tags);
      } catch (err) {
        console.error(`캐시 무효화 실패 tags=${tags.join(',')}:`, err);
      }
    },
  };
}
