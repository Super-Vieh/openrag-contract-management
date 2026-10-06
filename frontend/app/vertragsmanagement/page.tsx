"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  type CheckboxSelectionCallbackParams,
  type ColDef,
  type ColumnState,
  type GetRowIdParams,
  type IRowNode,
  themeQuartz,
  type ValueFormatterParams,
  type ValueGetterParams,
} from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { AlertTriangle, Cloud, FileIcon, Globe, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContractDropdown } from "@/components/contract-dropdown";
import { ProtectedRoute } from "@/components/protected-route";
import { Banner, BannerIcon, BannerTitle } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { useKnowledgeFilter } from "@/contexts/knowledge-filter-context";
import { useTask } from "@/contexts/task-context";
import { trackButton } from "@/lib/analytics";
import {
  EMPTY_SEARCH_RESULT,
  type File,
  type SearchResult,
  useGetSearchQuery,
} from "../api/queries/useGetSearchQuery";
import { useListFiles } from "../api/queries/useListFiles";
import "@/components/AgGrid/registerAgGridModules";
import "@/components/AgGrid/agGridStyles.css";
import { toast } from "sonner";
import { ContractSearchInput } from "@/components/contract-search-input";
import { KnowledgeActionsDropdown } from "@/components/knowledge-actions-dropdown";
import { KnowledgeBatchActionsBar } from "@/components/knowledge-batch-actions-bar";
import { KnowledgePaginationFooter } from "@/components/knowledge-pagination-footer";
import { KnowledgeSearchBar } from "@/components/knowledge-search-bar";
import { RequirePermission } from "@/components/require-permission";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsCloudBrand } from "@/contexts/brand-context";
import { getConnectorDescriptor } from "@/lib/connectors/registry";
import {
  extractParameter,
  extractParameterValue,
  translateMetadataValue,
} from "@/lib/contract-metadata";
import { formatFileSize } from "@/lib/file-format";
import { buildSearchPayloadFilters } from "@/lib/filter-normalization";
import {
  buildKnowledgeTableRows,
  getKnowledgeFileIdentity,
} from "@/lib/knowledge-table-state";
import { parseTimestampMs } from "@/lib/time-utils";
import { cn } from "@/lib/utils";
import {
  DeleteConfirmationDialog,
  formatFilesToDelete,
} from "../../components/delete-confirmation-dialog";
import { useDeleteDocument } from "../api/mutations/useDeleteDocument";
import { useRefreshOpenragDocs } from "../api/mutations/useRefreshOpenragDocs";
import { useUpdateDocument } from "../api/mutations/useUpdateDocument";

function sameFileSelection(a: File[], b: File[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const identities = new Set(b.map((row) => getKnowledgeFileIdentity(row)));
  return a.every((row) => identities.has(getKnowledgeFileIdentity(row)));
}

/** Failed overlays can stay selected after they lose their checkbox (processing → failed). */
function syncGridSelectionToDeletableRows(
  api: NonNullable<AgGridReact<File>["api"]>,
  isDeletable: (file?: File) => boolean,
): File[] {
  api.forEachNode((node) => {
    if (node.isSelected() && !isDeletable(node.data)) {
      node.setSelected(false);
    }
  });
  return api.getSelectedRows().filter(isDeletable);
}

/** Deselect non-deletable rows in the grid only; returns whether anything changed. */
function pruneNonDeletableGridSelection(
  api: NonNullable<AgGridReact<File>["api"]>,
  isDeletable: (file?: File) => boolean,
): boolean {
  let pruned = false;
  api.forEachNode((node) => {
    if (node.isSelected() && !isDeletable(node.data)) {
      node.setSelected(false);
      pruned = true;
    }
  });
  return pruned;
}

/** List-files uses term filters; "*" means "any" in the UI — do not send it literally. */
function listFilesFilterParam(values?: string[]): string | undefined {
  const raw = values?.[0]?.trim();
  if (!raw || raw === "*") {
    return undefined;
  }
  return raw;
}

// Function to get the appropriate icon for a connector type
function getSourceIcon(connectorType?: string) {
  if (connectorType) {
    const Icon = getConnectorDescriptor(connectorType)?.Icon;
    if (Icon) return <Icon className="h-4 w-4 text-foreground flex-shrink-0" />;
  }
  switch (connectorType) {
    case "openrag_docs":
    case "url":
      return <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    case "s3":
      return <Cloud className="h-4 w-4 text-foreground flex-shrink-0" />;
    default:
      return (
        <FileIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      );
  }
}

const AG_FIELD_TO_SORT_BY: Record<string, string> = {
  filename: "filename",
  size: "file_size",
  status: "status",
};

/** Contract metadata is free-form; read it without repeating the cast everywhere. */
function metadataOf(file?: File): Record<string, unknown> {
  return (file?.metadata ?? {}) as Record<string, unknown>;
}

/** Missing or non-array counts as none. */
function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Sort rank for the tri-state Extraction column: yes > no > unknown. */
function extractionRank(value: unknown): number {
  if (value === true) return 1;
  if (value === false) return 0;
  return -1;
}

/** Compare two optional numbers; missing values sort first. */
function compareOptionalNumbers(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/**
 * Columns whose values live only in document metadata, never as OpenSearch
 * fields. They sort client-side (see each column's `comparator`) — asking the
 * backend to sort by them would silently fall back to filename.
 */
const CLIENT_SORT_COLUMNS = new Set([
  "warnings",
  "errors",
  "extraktion_korrekt",
  "validierungsstatus",
  "gesamtwert",
]);

function SearchPage() {
  const isCloudBrand = useIsCloudBrand();
  const queryClient = useQueryClient();
  const router = useRouter();
  const {
    files: taskFiles,
    tasks,
    refreshTasks,
    openMenu,
    setRecentTasksExpanded,
    selectTask,
  } = useTask();
  const {
    parsedFilterData,
    queryOverride,
    selectedFilter,
    setSelectedSources,
  } = useKnowledgeFilter();
  const [selectedRows, setSelectedRows] = useState<File[]>([]);

  const [sortBy, setSortBy] = useState<string>("filename");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    setSelectedSources(
      selectedRows.flatMap((row) => (row.filename ? [row.filename] : [])),
    );
    return () => setSelectedSources([]);
  }, [selectedRows, setSelectedSources]);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showBulkUpdateDialog, setShowBulkUpdateDialog] = useState(false);
  const lastErrorRef = useRef<string | null>(null);
  const hasInitializedFailedFilesRef = useRef(false);
  const seenFailedFileKeysRef = useRef<Set<string>>(new Set());

  const deleteDocumentMutation = useDeleteDocument();
  const updateDocumentMutation = useUpdateDocument();
  const refreshOpenragDocsMutation = useRefreshOpenragDocs();

  const [currentPage, setCurrentPage] = useState(1);
  const [currentPageSize, setCurrentPageSize] = useState(25);

  const cursorCacheRef = useRef<Map<number, Record<string, unknown>>>(
    null as any,
  );
  if (!cursorCacheRef.current) {
    cursorCacheRef.current = new Map();
  }

  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);

  const getFailedFileKey = useCallback(
    (file: (typeof taskFiles)[number]) =>
      `${file.task_id}:${file.source_url || file.filename}`,
    [],
  );

  const getTaskIdForRow = useCallback(
    (file?: File): string | null => {
      if (!file) return null;
      const sourceUrl = file.source_url || "";
      const filename = file.filename || "";
      const matches = taskFiles.filter(
        (taskFile) =>
          (sourceUrl && taskFile.source_url === sourceUrl) ||
          taskFile.filename === filename,
      );
      if (matches.length === 0) return null;

      const failedMatches =
        file.status === "failed"
          ? matches.filter((taskFile) => taskFile.status === "failed")
          : matches;
      const candidates = failedMatches.length > 0 ? failedMatches : matches;

      const taskTimestampMsById = new Map(
        tasks.map((task) => [
          task.task_id,
          parseTimestampMs(task.updated_at) ??
            parseTimestampMs(task.created_at) ??
            0,
        ]),
      );

      const mostRecent = candidates.reduce(
        (best, cur) => {
          const curMs =
            taskTimestampMsById.get(cur.task_id) ??
            parseTimestampMs(cur.updated_at) ??
            parseTimestampMs(cur.created_at) ??
            0;
          if (!best) return cur;
          const bestMs =
            taskTimestampMsById.get(best.task_id) ??
            parseTimestampMs(best.updated_at) ??
            parseTimestampMs(best.created_at) ??
            0;
          return curMs > bestMs ? cur : best;
        },
        undefined as (typeof candidates)[0] | undefined,
      );

      return mostRecent?.task_id || null;
    },
    [taskFiles, tasks],
  );

  useEffect(() => {
    const failedFiles = taskFiles.filter((file) => file.status === "failed");
    const seenKeys = seenFailedFileKeysRef.current;

    if (!hasInitializedFailedFilesRef.current) {
      failedFiles.forEach((file) => {
        seenKeys.add(getFailedFileKey(file));
      });
      hasInitializedFailedFilesRef.current = true;
      return;
    }

    let firstNewFailureTaskId: string | null = null;
    const hasNewFailure = failedFiles.some((file) => {
      const key = getFailedFileKey(file);
      if (seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
      if (!firstNewFailureTaskId) {
        firstNewFailureTaskId = file.task_id;
      }
      return true;
    });

    if (hasNewFailure) {
      if (firstNewFailureTaskId) {
        selectTask(firstNewFailureTaskId);
      }
      openMenu();
      setRecentTasksExpanded(true);
    }
  }, [
    taskFiles,
    openMenu,
    setRecentTasksExpanded,
    selectTask,
    getFailedFileKey,
  ]);

  const effectiveSearchText =
    queryOverride.trim() || parsedFilterData?.query?.trim() || "";
  const hasActiveFilters = parsedFilterData?.filters
    ? buildSearchPayloadFilters(parsedFilterData.filters) !== undefined
    : false;
  const isWildcardQuery =
    (effectiveSearchText === "" || effectiveSearchText === "*") &&
    !hasActiveFilters;

  const {
    data: listFilesData,
    isLoading: isListFilesLoading,
    isFetching: isListFilesFetching,
    error: listFilesError,
    isError: isListFilesError,
  } = useListFiles(
    {
      page: currentPage,
      pageSize: currentPageSize,
      sortBy,
      sortOrder,
      afterKey: cursorCacheRef.current.get(currentPage) ?? null,
      connectorType: listFilesFilterParam(
        parsedFilterData?.filters?.connector_types,
      ),
      mimetype: listFilesFilterParam(parsedFilterData?.filters?.document_types),
      owner: listFilesFilterParam(parsedFilterData?.filters?.owners),
    },
    {
      refetchInterval: 5000,
      enabled: isWildcardQuery,
    },
  );

  const {
    data: searchData = EMPTY_SEARCH_RESULT,
    isLoading: isSearchLoading,
    error: searchError,
    isError: isSearchError,
  } = useGetSearchQuery(queryOverride, parsedFilterData, {
    enabled: !isWildcardQuery,
  });

  const { files: searchFiles, warnings: searchWarnings } =
    searchData as SearchResult;

  const isLoading = isWildcardQuery ? isListFilesLoading : isSearchLoading;

  const isFetching = isWildcardQuery ? isListFilesFetching : isSearchLoading;
  const error = isWildcardQuery ? listFilesError : searchError;
  const isError = isWildcardQuery ? isListFilesError : isSearchError;

  const effectiveData: File[] = isWildcardQuery
    ? (listFilesData?.files ?? [])
    : searchFiles.slice(
        (currentPage - 1) * currentPageSize,
        currentPage * currentPageSize,
      );

  const isOpenragDocsRow = useCallback((file?: File) => {
    return (
      file?.connector_type === "openrag_docs" ||
      file?.connector_type === "system_default"
    );
  }, []);

  const getFileIdentity = useCallback((file?: File) => {
    return getKnowledgeFileIdentity(file);
  }, []);

  const isDeletableKnowledgeRow = useCallback((file?: File) => {
    return (file?.status || "active") === "active";
  }, []);

  const resolveDeleteFilename = useCallback(
    (row: File) => {
      const identity = getKnowledgeFileIdentity(row);
      const indexed = effectiveData.find(
        (file) => getKnowledgeFileIdentity(file) === identity,
      );
      return indexed?.filename ?? row.filename;
    },
    [effectiveData],
  );

  const getStatusSortRank = useCallback((status?: File["status"]): number => {
    switch (status) {
      case "active":
        return 0;
      case "processing":
        return 1;
      case "sync":
        return 2;
      case "failed":
        return 3;
      case "unavailable":
        return 4;
      case "hidden":
        return 5;
      default:
        return 0;
    }
  }, []);

  const hasOpenragRefreshCueFromTasks = tasks.some((task) => {
    const isTaskActive =
      task.status === "pending" ||
      task.status === "running" ||
      task.status === "processing";
    if (!isTaskActive || !task.files) {
      return false;
    }

    return Object.entries(task.files).some(([fileKey, fileInfo]) => {
      const filename = (fileInfo as { filename?: string })?.filename ?? "";
      return (
        filename === "OpenRAG docs refresh" || fileKey.includes("openr.ag")
      );
    });
  });
  const hasOpenragRefreshCue =
    refreshOpenragDocsMutation.isPending || hasOpenragRefreshCueFromTasks;

  // Show toast notification for search errors
  useEffect(() => {
    if (isError && error) {
      const errorMessage =
        error instanceof Error ? error.message : "Search failed";
      // Avoid showing duplicate toasts for the same error
      if (lastErrorRef.current !== errorMessage) {
        lastErrorRef.current = errorMessage;
        toast.error("Search error", {
          description: errorMessage,
          duration: 5000,
        });
      }
    } else if (!isError) {
      // Reset when query succeeds
      lastErrorRef.current = null;
    }
  }, [isError, error]);
  const fileResults = buildKnowledgeTableRows(
    effectiveData,
    taskFiles,
    Boolean(selectedFilter),
  );

  const serverTotal = isWildcardQuery
    ? (listFilesData?.total ?? 0)
    : searchFiles.length;
  const gridRows: File[] = fileResults;
  const totalPages = Math.max(1, Math.ceil(serverTotal / currentPageSize));

  useEffect(() => {
    cursorCacheRef.current = new Map();
    setCurrentPage(1);
  }, [effectiveSearchText]);

  // when the server responds with an after_key for page N, cache it as the cursor for page N+1
  useEffect(() => {
    if (listFilesData?.after_key && listFilesData.page) {
      const nextPage = listFilesData.page + 1;
      cursorCacheRef.current.set(nextPage, listFilesData.after_key);
    }
  }, [listFilesData]);
  const gridRef = useRef<AgGridReact>(null);
  const gridReadyRef = useRef(false);

  const handleGridReady = useCallback(() => {
    gridReadyRef.current = true;
  }, []);

  const handleGridPreDestroyed = useCallback(() => {
    gridReadyRef.current = false;
  }, []);

  const getGridApi = useCallback(() => {
    if (!gridReadyRef.current) return null;
    return gridRef.current?.api ?? null;
  }, []);

  const onSortChanged = useCallback(() => {
    const api = getGridApi();
    if (!api) return;

    const sortedCol: ColumnState | undefined = api
      .getColumnState()
      .find((col) => col.sort != null);

    // Metadata columns sort client-side (see each column's comparator).
    // Refetching here would only reset paging and re-sort by the server-side
    // fallback field — the client-side order would be replaced a moment later.
    if (sortedCol && CLIENT_SORT_COLUMNS.has(sortedCol.colId)) return;

    const newSortBy = sortedCol
      ? (AG_FIELD_TO_SORT_BY[sortedCol.colId] ?? sortedCol.colId)
      : "filename";
    const newSortOrder: "asc" | "desc" =
      sortedCol?.sort === "desc" ? "desc" : "asc";

    // Changing sort invalidates all cursors; reset to page 1
    cursorCacheRef.current = new Map();
    setCurrentPage(1);
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
  }, [getGridApi]);

  const gridRowsSelectionKey = useMemo(
    () =>
      gridRows
        .map(
          (row) => `${getKnowledgeFileIdentity(row)}:${row.status ?? "active"}`,
        )
        .join("\0"),
    [gridRows],
  );

  useEffect(() => {
    const api = getGridApi();
    if (!api) {
      return;
    }
    pruneNonDeletableGridSelection(api, isDeletableKnowledgeRow);
    const nextSelected = api.getSelectedRows().filter(isDeletableKnowledgeRow);
    setSelectedRows((current) =>
      sameFileSelection(current, nextSelected) ? current : nextSelected,
    );
  }, [gridRowsSelectionKey, isDeletableKnowledgeRow, getGridApi]);

  const columnDefs: ColDef<File>[] = [
    {
      field: "filename",
      headerName: "Source",
      sortable: true,
      comparator: () => 0,
      checkboxSelection: (params: CheckboxSelectionCallbackParams<File>) =>
        isDeletableKnowledgeRow(params?.data),
      headerCheckboxSelection: true,
      ...(isCloudBrand
        ? { flex: 2.2, minWidth: 260 }
        : { initialFlex: 2, minWidth: 220 }),
      cellRenderer: ({ data, value }: CustomCellRendererProps<File>) => {
        const status = data?.status || "active";
        const isActive = status === "active";
        const showOpenragSourceAnimation =
          isOpenragDocsRow(data) && hasOpenragRefreshCue;
        return (
          <div className="flex items-center overflow-hidden w-full min-w-0 h-full">
            <div
              className={`transition-opacity duration-200 ${
                isActive ? "w-0" : "w-7"
              }`}
            ></div>
            <button
              type="button"
              className={cn(
                "flex items-center gap-2 text-left flex-1 overflow-hidden transition-colors",
                isActive
                  ? isCloudBrand
                    ? "cursor-pointer hover:text-primary"
                    : "cursor-pointer hover:text-blue-600"
                  : "cursor-default",
              )}
              onClick={() => {
                if (!isActive) return;
                router.push(
                  `/vertragsmanagement/chunks?filename=${encodeURIComponent(
                    data?.filename ?? "",
                  )}`,
                );
              }}
            >
              {getSourceIcon(data?.connector_type)}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "font-medium truncate min-w-0",
                      showOpenragSourceAnimation
                        ? "text-primary animate-pulse"
                        : "text-foreground",
                    )}
                  >
                    {value}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  {value}
                </TooltipContent>
              </Tooltip>
            </button>
          </div>
        );
      },
    },
    {
      field: "size",
      headerName: "Size",
      ...(isCloudBrand ? { flex: 1, minWidth: 110 } : {}),
      sortable: true,
      comparator: () => 0,
      valueFormatter: (params: ValueFormatterParams<File>) =>
        params.value ? formatFileSize(params.value) : "-",
      cellClass: isCloudBrand ? "text-muted-foreground" : undefined,
    },
    {
      colId: "warnings",
      headerName: "Warnings",
      ...(isCloudBrand ? { flex: 1, minWidth: 120 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) =>
        listLength(metadataOf(params.data).warnings),
      comparator: (valueA?: number, valueB?: number) =>
        (valueA ?? 0) - (valueB ?? 0),
      cellRenderer: ({ value }: CustomCellRendererProps<File>) => {
        const count = typeof value === "number" ? value : 0;
        return (
          <div
            className={cn(
              "inline-flex items-center gap-1",
              count > 0
                ? "text-accent-amber-foreground"
                : "text-accent-emerald-foreground",
            )}
          >
            {count > 0 ? `${count}` : "None"}
          </div>
        );
      },
    },
    {
      colId: "errors",
      headerName: "Errors",
      ...(isCloudBrand ? { flex: 1, minWidth: 110 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) =>
        listLength(metadataOf(params.data).errors),
      comparator: (valueA?: number, valueB?: number) =>
        (valueA ?? 0) - (valueB ?? 0),
      cellRenderer: ({ value }: CustomCellRendererProps<File>) => {
        const count = typeof value === "number" ? value : 0;
        return (
          <div
            className={cn(
              "inline-flex items-center gap-1",
              count > 0
                ? "text-accent-red-foreground"
                : "text-accent-emerald-foreground",
            )}
          >
            {count > 0 ? `${count}` : "None"}
          </div>
        );
      },
    },
    {
      colId: "extraktion_korrekt",
      headerName: "Extraction",
      ...(isCloudBrand ? { flex: 1, minWidth: 130 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) =>
        metadataOf(params.data).extraktion_korrekt,
      comparator: (valueA?: unknown, valueB?: unknown) =>
        extractionRank(valueA) - extractionRank(valueB),
      cellRenderer: ({ value }: CustomCellRendererProps<File>) => {
        if (typeof value !== "boolean") return null;
        return (
          <div
            className={cn(
              "inline-flex items-center gap-1",
              value
                ? "text-accent-emerald-foreground"
                : "text-accent-red-foreground",
            )}
          >
            {value ? "yes" : "no"}
          </div>
        );
      },
    },
    {
      colId: "validierungsstatus",
      headerName: "Validation",
      ...(isCloudBrand ? { flex: 1.6, minWidth: 200 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) => {
        const status = metadataOf(params.data).status;
        if (typeof status !== "string" || !status) return null;
        return translateMetadataValue(status);
      },
      comparator: (valueA?: unknown, valueB?: unknown) =>
        String(valueA ?? "").localeCompare(String(valueB ?? ""), "de"),
      cellRenderer: ({ value }: CustomCellRendererProps<File>) =>
        typeof value === "string" && value ? (
          <span className="truncate">{value}</span>
        ) : null,
    },
    {
      colId: "gesamtwert",
      headerName: "Total value",
      ...(isCloudBrand ? { flex: 1.2, minWidth: 150 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) =>
        extractParameter(metadataOf(params.data), "gesamtwert"),
      comparator: (
        _valueA,
        _valueB,
        nodeA: IRowNode<File>,
        nodeB: IRowNode<File>,
      ) =>
        compareOptionalNumbers(
          extractParameterValue(nodeA.data?.metadata, "gesamtwert"),
          extractParameterValue(nodeB.data?.metadata, "gesamtwert"),
        ),
      cellRenderer: ({ value }: CustomCellRendererProps<File>) =>
        typeof value === "string" && value ? (
          <span className="truncate">{value}</span>
        ) : null,
    },
    {
      field: "status",
      headerName: "Status",
      ...(isCloudBrand ? { flex: 1, minWidth: 130 } : {}),
      sortable: true,
      valueGetter: (params: ValueGetterParams<File>) =>
        params.data?.status || "active",
      comparator: (valueA?: File["status"], valueB?: File["status"]) =>
        getStatusSortRank(valueA) - getStatusSortRank(valueB),
      cellRenderer: ({ data }: CustomCellRendererProps<File>) => {
        const status = data?.status || "active";
        const showOpenragRefreshCue =
          isOpenragDocsRow(data) && hasOpenragRefreshCue;

        if (showOpenragRefreshCue) {
          if (isCloudBrand) {
            return (
              <div className="inline-flex items-center gap-2 text-primary">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span className="text-sm font-medium">Refreshing</span>
              </div>
            );
          }
          return (
            <div className="inline-flex items-center justify-center h-5 w-5">
              <RefreshCw
                className="h-4 w-4 text-primary animate-spin"
                aria-label="OpenRAG doc is refreshing"
              />
            </div>
          );
        }

        if (status === "failed") {
          return (
            <button
              type="button"
              className={cn(
                "inline-flex items-center h-full transition",
                isCloudBrand
                  ? "text-destructive hover:opacity-80"
                  : "w-full text-red-500 hover:text-red-400",
              )}
              aria-label="View ingestion error"
              data-testid="failed-status-cell-trigger"
              onClick={() => {
                selectTask(getTaskIdForRow(data));
                openMenu();
                setRecentTasksExpanded(true);
              }}
            >
              <StatusBadge status={status} className="pointer-events-none" />
            </button>
          );
        }

        return <StatusBadge status={status} />;
      },
    },
    {
      colId: "actions",
      headerName: "",
      width: isCloudBrand ? 56 : 40,
      minWidth: isCloudBrand ? 56 : 0,
      ...(isCloudBrand ? { maxWidth: 56 } : { initialFlex: 0 }),
      sortable: false,
      filter: false,
      resizable: false,
      suppressMovable: true,
      cellRenderer: ({ data }: CustomCellRendererProps<File>) => {
        const status = data?.status || "active";
        if (status !== "active") return null;
        return (
          <KnowledgeActionsDropdown
            filename={data?.filename || ""}
            connectorType={data?.connector_type}
          />
        );
      },
      cellStyle: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      },
    },
  ];

  const defaultColDef: ColDef<File> = {
    resizable: false,
    suppressMovable: true,
    ...(isCloudBrand ? { sortable: false } : {}),
    initialFlex: 1,
    minWidth: 100,
  };

  const onSelectionChanged = useCallback(() => {
    const api = getGridApi();
    if (!api) {
      return;
    }
    const nextSelected = syncGridSelectionToDeletableRows(
      api,
      isDeletableKnowledgeRow,
    );
    setSelectedRows((current) =>
      sameFileSelection(current, nextSelected) ? current : nextSelected,
    );
  }, [isDeletableKnowledgeRow, getGridApi]);

  const handleBulkDelete = async () => {
    const rowsToDelete = selectedRows.filter(isDeletableKnowledgeRow);
    if (rowsToDelete.length === 0) return;

    try {
      const deleteResults = await Promise.allSettled(
        rowsToDelete.map((row) =>
          deleteDocumentMutation.mutateAsync({
            filename: resolveDeleteFilename(row),
          }),
        ),
      );

      await Promise.all([
        refreshTasks(),
        queryClient.invalidateQueries({ queryKey: ["search"] }),
        queryClient.invalidateQueries({ queryKey: ["listFiles"] }),
        queryClient.refetchQueries({ queryKey: ["search"] }),
        queryClient.refetchQueries({ queryKey: ["listFiles"] }),
      ]);

      const deleted = deleteResults.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof deleteDocumentMutation.mutateAsync>>
        > =>
          result.status === "fulfilled" &&
          (result.value.deleted_chunks || 0) > 0,
      );
      const noChunks = deleteResults.filter(
        (result) =>
          result.status === "fulfilled" &&
          (result.value.deleted_chunks || 0) === 0,
      );
      const failed = deleteResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (deleted.length > 0) {
        toast.success(
          `Deleted ${deleted.length} document${deleted.length > 1 ? "s" : ""}`,
        );
      } else if (failed.length === 0) {
        toast.warning(
          "No document chunks were deleted. Files may be missing or not deletable in your current context.",
        );
      }

      if (noChunks.length > 0 && deleted.length > 0) {
        toast.warning(
          `${noChunks.length} selected file${noChunks.length > 1 ? "s had" : " had"} no matching chunks.`,
        );
      }

      if (failed.length > 0) {
        toast.error(
          `${failed.length} document${failed.length > 1 ? "s" : ""} could not be deleted`,
          {
            description:
              failed[0].reason instanceof Error
                ? failed[0].reason.message
                : undefined,
          },
        );
      }
      setSelectedRows([]);
      setShowBulkDeleteDialog(false);

      // Clear selection in the grid
      getGridApi()?.deselectAll();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to delete some documents",
      );
      setShowBulkDeleteDialog(false);
    }
  };

  const handleBulkUpdate = async () => {
    const rowsToUpdate = selectedRows.filter(isDeletableKnowledgeRow);
    if (rowsToUpdate.length === 0) {
      setShowBulkUpdateDialog(false);
      return;
    }

    // Re-ingest is a background task per file, so fan out into N single
    // requests the same way handleBulkDelete does.
    const results = await Promise.allSettled(
      rowsToUpdate.map((row) =>
        updateDocumentMutation.mutateAsync({
          filename: resolveDeleteFilename(row),
        }),
      ),
    );

    await refreshTasks();

    const started = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (started.length > 0) {
      toast.success(
        `Update started for ${started.length} document${started.length > 1 ? "s" : ""}. Check task notifications for progress.`,
      );
    }
    if (failed.length > 0) {
      toast.error(
        `${failed.length} document${failed.length > 1 ? "s" : ""} could not be updated`,
        {
          description:
            failed[0].reason instanceof Error
              ? failed[0].reason.message
              : undefined,
        },
      );
    }

    setSelectedRows([]);
    getGridApi()?.deselectAll();
    setShowBulkUpdateDialog(false);
  };

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between mb-6">
          <h2
            className={cn(
              "text-lg font-semibold",
              isCloudBrand && "ibm-section-title",
            )}
          >
            Documents
          </h2>
        </div>
        {isCloudBrand ? (
          <div className="relative overflow-hidden h-12 shrink-0">
            <div
              className={cn(
                "transition-transform duration-200 ease-in-out",
                selectedRows.length > 0
                  ? "-translate-y-full pointer-events-none select-none"
                  : "translate-y-0",
              )}
            >
              <KnowledgeSearchBar />
            </div>
            <div
              className={cn(
                "absolute top-0 left-0 right-0 h-12 transition-transform duration-200 ease-in-out",
                selectedRows.length > 0
                  ? "translate-y-0"
                  : "translate-y-full pointer-events-none select-none",
              )}
            >
              <KnowledgeBatchActionsBar
                selectedCount={selectedRows.length}
                onDelete={() => setShowBulkDeleteDialog(true)}
                onCancel={() => {
                  setSelectedRows([]);
                  getGridApi()?.deselectAll();
                }}
              />
            </div>
          </div>
        ) : (
          /* Search Input Area */
          <div className="flex items-center flex-shrink-0 flex-wrap-reverse gap-3 mb-6">
            <ContractSearchInput />

            <RequirePermission perm="config:write">
              <Button
                type="button"
                variant="outline"
                className="rounded-lg flex-shrink-0"
                disabled={refreshOpenragDocsMutation.isPending}
                onClick={async () => {
                  trackButton({
                    CTA: "Fetch Latest Docs",
                    elementId: "fetch-latest-docs-button",
                    namespace: "knowledge",
                  });
                  try {
                    toast.info("Refreshing OpenRAG docs...");
                    const result =
                      await refreshOpenragDocsMutation.mutateAsync();
                    toast.success(result.message);
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to refresh OpenRAG docs",
                    );
                  }
                }}
              >
                {refreshOpenragDocsMutation.isPending ? (
                  <>Refreshing docs...</>
                ) : (
                  <>Fetch latest docs</>
                )}
              </Button>
            </RequirePermission>
            {selectedRows.length > 0 && (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  className="rounded-lg flex-shrink-0"
                  disabled={updateDocumentMutation.isPending}
                  onClick={() => setShowBulkUpdateDialog(true)}
                >
                  {updateDocumentMutation.isPending ? "Updating..." : "Update"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="rounded-lg flex-shrink-0"
                  onClick={() => setShowBulkDeleteDialog(true)}
                >
                  Delete
                </Button>
              </>
            )}
            <div className="ml-auto">
              <ContractDropdown />
            </div>
          </div>
        )}
        {!isWildcardQuery && searchWarnings.length > 0 && (
          <div className="mb-4 flex flex-col gap-2">
            {searchWarnings.map((warning, idx) => {
              const isEmbeddingWarning =
                warning.code === "embedding_unavailable";
              const semanticDown =
                isEmbeddingWarning &&
                warning.semantic_search_available === false;
              const title = isEmbeddingWarning
                ? semanticDown
                  ? "Semantic search degraded — keyword results only"
                  : "Semantic search partially degraded"
                : warning.message || "Search warning";
              const details =
                warning.models && warning.models.length > 0
                  ? ` Affected embedding model${warning.models.length > 1 ? "s" : ""}: ${warning.models.join(", ")}.`
                  : "";
              return (
                <Banner
                  key={`${warning.code}-${idx}`}
                  inset
                  className="bg-amber-500/10 text-amber-100 border border-amber-500/30"
                >
                  <BannerIcon icon={AlertTriangle} />
                  <BannerTitle>
                    <span className="font-medium">{title}.</span>
                    <span className="ml-1 opacity-90">
                      {isEmbeddingWarning
                        ? `The provider for some indexed documents is no longer reachable, so results rely on keyword matching.${details} Re-configure the provider or re-ingest those documents with another embedding model to restore semantic search.`
                        : warning.message}
                    </span>
                  </BannerTitle>
                </Banner>
              );
            })}
          </div>
        )}
        {isCloudBrand ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <AgGridReact
              className="w-full h-full border"
              columnDefs={columnDefs as ColDef<File>[]}
              defaultColDef={defaultColDef}
              loading={isLoading || deleteDocumentMutation.isPending}
              ref={gridRef}
              theme={themeQuartz.withParams({ browserColorScheme: "inherit" })}
              rowData={gridRows}
              rowSelection="multiple"
              getRowId={(params: GetRowIdParams<File>) =>
                getFileIdentity(params.data)
              }
              isRowSelectable={(params) => isDeletableKnowledgeRow(params.data)}
              domLayout="normal"
              onGridReady={handleGridReady}
              onGridPreDestroyed={handleGridPreDestroyed}
              onSelectionChanged={onSelectionChanged}
              onSortChanged={onSortChanged}
              headerHeight={64}
              rowHeight={64}
              noRowsOverlayComponent={() => (
                <div className="text-center pb-[45px]">
                  <div className="text-lg text-primary font-semibold">
                    No knowledge
                  </div>
                  <div className="text-sm mt-1 text-muted-foreground">
                    Add files from local or your preferred cloud.
                  </div>
                </div>
              )}
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            <AgGridReact
              className="w-full h-full"
              columnDefs={columnDefs as ColDef<File>[]}
              defaultColDef={defaultColDef}
              loading={isLoading || deleteDocumentMutation.isPending}
              ref={gridRef}
              theme={themeQuartz.withParams({ browserColorScheme: "inherit" })}
              rowData={gridRows}
              rowSelection="multiple"
              rowMultiSelectWithClick={false}
              suppressRowClickSelection={true}
              getRowId={(params: GetRowIdParams<File>) =>
                getFileIdentity(params.data)
              }
              isRowSelectable={(params) => isDeletableKnowledgeRow(params.data)}
              domLayout="normal"
              onGridReady={handleGridReady}
              onGridPreDestroyed={handleGridPreDestroyed}
              onSelectionChanged={onSelectionChanged}
              onSortChanged={onSortChanged}
              noRowsOverlayComponent={() => (
                <div className="text-center pb-[45px]">
                  <div className="text-lg text-primary font-semibold">
                    No knowledge
                  </div>
                  <div className="text-sm mt-1 text-muted-foreground">
                    Add files from local or your preferred cloud.
                  </div>
                </div>
              )}
            />
          </div>
        )}

        <KnowledgePaginationFooter
          currentPage={currentPage}
          currentPageSize={currentPageSize}
          totalPages={totalPages}
          serverTotal={serverTotal}
          isLoading={isFetching}
          cursorCacheRef={cursorCacheRef}
          setCurrentPage={setCurrentPage}
          setCurrentPageSize={setCurrentPageSize}
        />
      </div>

      {/* Bulk Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        title={selectedRows.length > 1 ? "Delete documents" : "Delete document"}
        description={`Are you sure you want to delete ${selectedRows.length} document${selectedRows.length > 1 ? "s" : ""}?`}
        confirmText={selectedRows.length > 1 ? "Delete all" : "Delete"}
        onConfirm={handleBulkDelete}
        isLoading={deleteDocumentMutation.isPending}
      >
        <p className="my-2">
          This will remove all chunks and data associated with these documents.
          This action cannot be undone.
        </p>
        <p className="my-2">Documents to be deleted:</p>
        {formatFilesToDelete(selectedRows)}
      </DeleteConfirmationDialog>

      <DeleteConfirmationDialog
        open={showBulkUpdateDialog}
        onOpenChange={setShowBulkUpdateDialog}
        title={selectedRows.length > 1 ? "Update documents" : "Update document"}
        description={`Re-read the stored original${selectedRows.length > 1 ? "s" : ""} for ${selectedRows.length} document${selectedRows.length > 1 ? "s" : ""}?`}
        confirmText={selectedRows.length > 1 ? "Update all" : "Update"}
        onConfirm={handleBulkUpdate}
        isLoading={updateDocumentMutation.isPending}
      >
        <p className="my-2">
          The existing chunks are removed and the document is ingested again
          from the file stored in Langflow. Until that run finishes the document
          is missing from the index.
        </p>
        <p className="my-2">Documents to be updated:</p>
        {formatFilesToDelete(selectedRows)}
      </DeleteConfirmationDialog>
    </>
  );
}

export default function ProtectedSearchPage() {
  return (
    <ProtectedRoute>
      <SearchPage />
    </ProtectedRoute>
  );
}
