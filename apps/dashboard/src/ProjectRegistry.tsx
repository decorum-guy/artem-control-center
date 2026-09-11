import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectRegistryProjectInput, ProjectRegistrySettings } from "@artem/contracts";
import {
  createProject as createProjectRequest,
  deleteProject as deleteProjectRequest,
  getProjectRegistry,
  PROJECT_REGISTRY_CAPABILITY,
  ProjectRegistryApiError,
  replaceProject as replaceProjectRequest
} from "./projectRegistryApi";

export type ProjectRegistryMutation = "create" | "replace" | "delete" | "connection-test";

export interface ProjectRegistryController {
  registry: ProjectRegistrySettings | null;
  loading: boolean;
  error: ProjectRegistryApiError | null;
  mutationPending: boolean;
  mutationKind: ProjectRegistryMutation | null;
  refresh: () => Promise<ProjectRegistrySettings | null>;
  beginMutation: (kind: ProjectRegistryMutation) => boolean;
  endMutation: () => void;
  create: (project: ProjectRegistryProjectInput) => Promise<ProjectRegistrySettings>;
  replace: (projectId: string, project: ProjectRegistryProjectInput) => Promise<ProjectRegistrySettings>;
  remove: (projectId: string) => Promise<ProjectRegistrySettings>;
}

const ProjectRegistryContext = createContext<ProjectRegistryController | null>(null);

function projectRegistryError(value: unknown): ProjectRegistryApiError {
  return value instanceof ProjectRegistryApiError
    ? value
    : new ProjectRegistryApiError("project_registry_unavailable", 503);
}

export function ProjectRegistryProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<ProjectRegistrySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProjectRegistryApiError | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationKind, setMutationKind] = useState<ProjectRegistryMutation | null>(null);
  const registryRef = useRef<ProjectRegistrySettings | null>(null);
  const mutationPendingRef = useRef(false);
  const inFlightRef = useRef<Promise<ProjectRegistrySettings> | null>(null);
  const refreshGenerationRef = useRef(0);
  registryRef.current = registry;

  const refresh = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    setLoading(true);
    try {
      const next = await getProjectRegistry();
      if (generation !== refreshGenerationRef.current) return registryRef.current;
      registryRef.current = next;
      setRegistry(next);
      setError(null);
      return next;
    } catch (value) {
      if (generation !== refreshGenerationRef.current) return registryRef.current;
      const nextError = projectRegistryError(value);
      setError(nextError);
      return null;
    } finally {
      if (generation === refreshGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onCapabilitiesChanged = () => void refresh();
    window.addEventListener("artem-capabilities-changed", onCapabilitiesChanged);
    return () => window.removeEventListener("artem-capabilities-changed", onCapabilitiesChanged);
  }, [refresh]);

  const beginMutation = useCallback((kind: ProjectRegistryMutation) => {
    if (mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    setMutationPending(true);
    setMutationKind(kind);
    return true;
  }, []);

  const endMutation = useCallback(() => {
    mutationPendingRef.current = false;
    setMutationPending(false);
    setMutationKind(null);
  }, []);

  const runMutation = useCallback((kind: ProjectRegistryMutation, request: (expectedRevision: number) => Promise<ProjectRegistrySettings>) => {
    const existing = inFlightRef.current;
    if (existing) return existing;

    const current = registryRef.current;
    if (!current) return Promise.reject(new ProjectRegistryApiError("project_registry_unavailable", 503));

    const claimedHere = !mutationPendingRef.current;
    if (claimedHere) beginMutation(kind);

    const nextRequest = Promise.resolve()
      .then(() => request(current.revision))
      .then((next) => {
        refreshGenerationRef.current += 1;
        setLoading(false);
        registryRef.current = next;
        setRegistry(next);
        setError(null);
        return next;
      })
      .finally(() => {
        inFlightRef.current = null;
        if (claimedHere) endMutation();
      });
    inFlightRef.current = nextRequest;
    return nextRequest;
  }, [beginMutation, endMutation]);

  const create = useCallback(
    (project: ProjectRegistryProjectInput) => runMutation("create", (expectedRevision) => createProjectRequest(project, expectedRevision)),
    [runMutation]
  );

  const replace = useCallback(
    (projectId: string, project: ProjectRegistryProjectInput) => runMutation("replace", (expectedRevision) => replaceProjectRequest(projectId, project, expectedRevision)),
    [runMutation]
  );

  const remove = useCallback(
    (projectId: string) => runMutation("delete", (expectedRevision) => deleteProjectRequest(projectId, expectedRevision)),
    [runMutation]
  );

  const value = useMemo<ProjectRegistryController>(() => ({
    registry,
    loading,
    error,
    mutationPending,
    mutationKind,
    refresh,
    beginMutation,
    endMutation,
    create,
    replace,
    remove
  }), [beginMutation, create, endMutation, error, loading, mutationKind, mutationPending, refresh, registry, remove, replace]);

  return <ProjectRegistryContext.Provider value={value}>{children}</ProjectRegistryContext.Provider>;
}

export function useProjectRegistry(): ProjectRegistryController {
  const value = useContext(ProjectRegistryContext);
  if (!value) throw new Error("useProjectRegistry must be used inside ProjectRegistryProvider");
  return value;
}

export { PROJECT_REGISTRY_CAPABILITY };
