import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { Route, Routes } from "react-router-dom";
import NotFound from "./pages/NotFound";

const Index = lazy(() => import("./pages/Index"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));

export function AppRoutes() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center bg-background"><LoaderCircle className="h-6 w-6 animate-spin text-primary" /></div>}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/api-docs" element={<ApiDocs />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
