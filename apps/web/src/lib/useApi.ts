import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type State<T> = { data: T | null; error: Error | null; loading: boolean };

const cache = new Map<string, unknown>();

/** GET with an in-memory cache so moving between screens shows the last value at once. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<State<T>>(() => ({
    data: path ? ((cache.get(path) as T | undefined) ?? null) : null,
    error: null,
    loading: path !== null,
  }));

  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api<T>(path);
      cache.set(path, data);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error as Error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load, setData: (data: T) => setState((s) => ({ ...s, data })) };
}
