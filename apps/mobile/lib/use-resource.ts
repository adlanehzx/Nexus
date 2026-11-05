import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { describeFailure, type Failure } from "./errors.js";
import { useNexus } from "./nexus.js";
import { resourceCache as cache } from "./resource-cache.js";

/**
 * Server data for a screen.
 *
 * Stale-while-revalidate: what was last seen stays on screen during a refresh
 * and through a failed one, which on a phone is routine. The cache is per
 * process and keyed by the caller, so returning to a tab is instant and a tab
 * switch does not flash a spinner. It reloads on focus and on reconnection.
 */

export interface Resource<T> {
  data: T | undefined;
  /** First load, with nothing to show yet. */
  loading: boolean;
  /** Reload with existing data on screen. */
  refreshing: boolean;
  failure: Failure | undefined;
  reload: () => Promise<void>;
}

export function useResource<T>(key: string, fetcher: () => Promise<T>): Resource<T> {
  const { state } = useNexus();
  const [data, setData] = useState<T | undefined>(() => cache.get(key) as T | undefined);
  const [loading, setLoading] = useState(!cache.has(key));
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<Failure>();

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (cache.has(key)) setRefreshing(true);
    try {
      const value = await fetcherRef.current();
      if (current !== generation.current) return;
      cache.set(key, value);
      setData(value);
      setFailure(undefined);
    } catch (cause) {
      if (current !== generation.current) return;
      setFailure(describeFailure(cause));
    } finally {
      if (current === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [key]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // The channel just came back: whatever was on screen may be out of date.
  const previousConnection = useRef(state.connection);
  useEffect(() => {
    const wasConnected = previousConnection.current === "connected";
    previousConnection.current = state.connection;
    if (state.connection === "connected" && !wasConnected) void reload();
  }, [state.connection, reload]);

  return { data, loading, refreshing, failure, reload };
}

/** Reloads on an interval while the screen is focused, for what has no realtime frame. */
export function useAutoRefresh(reload: () => Promise<void>, intervalMs: number): void {
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        void reload();
      }, intervalMs);
      return () => {
        clearInterval(timer);
      };
    }, [reload, intervalMs]),
  );
}
