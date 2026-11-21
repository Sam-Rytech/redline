import type { LoansResponse } from "@redline/api-types";
import { useApi } from "./useApi";

export const useLoans = () => useApi<LoansResponse>("/loans");
