import { type RequestInfo } from "../requestInfo/types.js";
import {
  BUILD_ID_META_NAME,
  bootstrapErrorGuardScript,
} from "../client/staleAsset.js";
import { Preloads } from "./preloads.js";
import { Stylesheets } from "./stylesheets.js";

const RWSDK_BUILD_ID: string =
  ((import.meta as any)?.env?.RWSDK_BUILD_ID as string | undefined) ?? "rwsdk";

// Note: This is a server component, even though it doesn't have the "use server"
// directive. It's intended to be imported and used within the RSC render pass.
export const assembleDocument = ({
  requestInfo,
  pageElement,
  shouldSSR,
}: {
  requestInfo: RequestInfo;
  pageElement: React.ReactNode;
  shouldSSR: boolean;
}) => {
  // todo(justinvdm, 18 Jun 2025): We can build on this later to allow users
  // surface context. e.g:
  // * we assign `user: requestInfo.clientCtx` here
  // * user populates requestInfo.clientCtx on worker side
  // * user can import a read only `import { clientCtx } from "rwsdk/client"`
  // on client side
  const clientContext = {
    rw: {
      ssr: shouldSSR,
    },
  };

  const Document = requestInfo.rw.Document;

  return (
    <Document {...requestInfo}>
      {/* Build-id meta is read by the client at boot and compared against the
          X-Rwsdk-Build-Id header on every RSC response to detect deploy
          boundaries. See runtime/client/staleAsset.ts. */}
      <meta name={BUILD_ID_META_NAME} content={RWSDK_BUILD_ID} />
      {/* Pre-hydrate guard: catches module-script load failures before any
          client code runs, e.g. when client.tsx itself 404s mid CDN
          propagation. Inlined as a string so it executes synchronously without
          its own module fetch. */}
      <script
        nonce={requestInfo.rw.nonce}
        dangerouslySetInnerHTML={{ __html: bootstrapErrorGuardScript }}
      />
      <script
        nonce={requestInfo.rw.nonce}
        dangerouslySetInnerHTML={{
          __html: `globalThis.__RWSDK_CONTEXT = ${JSON.stringify(
            clientContext,
          )}`,
        }}
      />
      <Stylesheets requestInfo={requestInfo} />
      <Preloads requestInfo={requestInfo} />
      <div id="hydrate-root">{pageElement}</div>
    </Document>
  );
};
