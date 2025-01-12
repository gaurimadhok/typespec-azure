import {
  PagedResultMetadata,
  UnionEnum,
  extractLroStates,
  getArmResourceIdentifierConfig,
  getAsEmbeddingVector,
  getLroMetadata,
  getPagedResult,
  getUnionAsEnum,
  isFixed,
} from "@azure-tools/typespec-azure-core";
import {
  getArmCommonTypeOpenAPIRef,
  isArmCommonType,
} from "@azure-tools/typespec-azure-resource-manager";
import { shouldFlattenProperty } from "@azure-tools/typespec-client-generator-core";
import {
  ArrayModelType,
  BooleanLiteral,
  CompilerHost,
  Diagnostic,
  DiagnosticTarget,
  Enum,
  EnumMember,
  IntrinsicScalarName,
  IntrinsicType,
  Model,
  ModelProperty,
  Namespace,
  NoTarget,
  NumericLiteral,
  Operation,
  Program,
  Scalar,
  SourceFile,
  StringLiteral,
  StringTemplate,
  SyntaxKind,
  Type,
  TypeNameOptions,
  Union,
  UnionVariant,
  Value,
  compilerAssert,
  createDiagnosticCollector,
  explainStringTemplateNotSerializable,
  getAllTags,
  getDirectoryPath,
  getDiscriminator,
  getDoc,
  getEncode,
  getFormat,
  getKnownValues,
  getMaxItems,
  getMaxLength,
  getMaxValue,
  getMinItems,
  getMinLength,
  getMinValue,
  getPattern,
  getProjectedName,
  getProperty,
  getPropertyType,
  getRelativePathFromDirectory,
  getRootLength,
  getSummary,
  getVisibility,
  ignoreDiagnostics,
  interpolatePath,
  isArrayModelType,
  isDeprecated,
  isErrorModel,
  isErrorType,
  isGlobalNamespace,
  isNeverType,
  isNullType,
  isNumericType,
  isRecordModelType,
  isSecret,
  isService,
  isStringType,
  isTemplateDeclaration,
  isTemplateDeclarationOrInstance,
  isVoidType,
  navigateTypesInNamespace,
  resolveEncodedName,
  resolvePath,
} from "@typespec/compiler";
import { TwoLevelMap } from "@typespec/compiler/utils";
import {
  Authentication,
  HttpAuth,
  HttpOperation,
  HttpOperationParameters,
  HttpOperationResponse,
  HttpOperationResponseBody,
  HttpStatusCodeRange,
  HttpStatusCodesEntry,
  MetadataInfo,
  OAuth2FlowType,
  Visibility,
  createMetadataInfo,
  getAllHttpServices,
  getAuthentication,
  getHeaderFieldOptions,
  getQueryParamOptions,
  getServers,
  getStatusCodeDescription,
  getVisibilitySuffix,
  isContentTypeHeader,
  isSharedRoute,
  reportIfNoRoutes,
  resolveRequestVisibility,
} from "@typespec/http";
import {
  checkDuplicateTypeName,
  getExtensions,
  getExternalDocs,
  getOpenAPITypeName,
  getParameterKey,
  isReadonlyProperty,
  resolveInfo,
  shouldInline,
} from "@typespec/openapi";
import { getVersionsForEnum } from "@typespec/versioning";
import { AutorestOpenAPISchema } from "./autorest-openapi-schema.js";
import { getExamples, getRef } from "./decorators.js";
import { sortWithJsonSchema } from "./json-schema-sorter/sorter.js";
import { createDiagnostic, reportDiagnostic } from "./lib.js";
import {
  OpenAPI2Document,
  OpenAPI2FormDataParameter,
  OpenAPI2HeaderDefinition,
  OpenAPI2OAuth2FlowType,
  OpenAPI2Operation,
  OpenAPI2Parameter,
  OpenAPI2ParameterType,
  OpenAPI2PathItem,
  OpenAPI2PathParameter,
  OpenAPI2Response,
  OpenAPI2Schema,
  OpenAPI2SchemaProperty,
  OpenAPI2SecurityScheme,
  OpenAPI2StatusCode,
  PrimitiveItems,
  Refable,
} from "./openapi2-document.js";
import { AutorestEmitterContext, getClientName, resolveOperationId } from "./utils.js";

interface SchemaContext {
  readonly visibility: Visibility;
  readonly ignoreMetadataAnnotations: boolean;
}

/**
 * Options to configure the behavior of the Autorest document emitter.
 */
export interface AutorestDocumentEmitterOptions {
  readonly examplesDirectory?: string;

  /**
   * Omit unreachable types.
   * By default all types declared under the service namespace will be included. With this flag on only types references in an operation will be emitted.
   */
  readonly omitUnreachableTypes?: boolean;

  /**
   * If the x-typespec-name extension should be included
   */
  readonly includeXTypeSpecName: "inline-only" | "never";

  /**
   * Arm types dir
   */
  readonly armTypesDir: string;

  /**
   * readOnly property schema behavior
   */
  readonly useReadOnlyStatusSchema?: boolean;

  /**
   * Decide how to deal with the version enum when `omitUnreachableTypes` is not set.
   * @default "omit"
   */
  readonly versionEnumStrategy?: "omit" | "include";
}

/**
 * Represents a node that will hold a JSON reference. The value is computed
 * at the end so that we can defer decisions about the name that is
 * referenced.
 */
class Ref {
  value?: string;
  toJSON() {
    compilerAssert(this.value, "Reference value never set.");
    return this.value;
  }
}

/**
 * Represents a non-inlined schema that will be emitted as a definition.
 * Computation of the OpenAPI schema object is deferred.
 */
interface PendingSchema {
  /** The TYPESPEC type for the schema */
  type: Type;

  /** The visibility to apply when computing the schema */
  visibility: Visibility;

  /**
   * The JSON reference to use to point to this schema.
   *
   * Note that its value will not be computed until all schemas have been
   * computed as we will add a suffix to the name if more than one schema
   * must be emitted for the type for different visibilities.
   */
  ref: Ref;
}

/**
 * Represents a schema that is ready to emit as its OpenAPI representation
 * has been produced.
 */
interface ProcessedSchema extends PendingSchema {
  schema: OpenAPI2Schema | undefined;
}

export interface OperationExamples {
  readonly operationId: string;
  readonly examples: LoadedExample[];
}

export interface AutorestEmitterResult {
  readonly document: OpenAPI2Document;
  readonly operationExamples: OperationExamples[];
}

export async function getOpenAPIForService(
  context: AutorestEmitterContext,
  options: AutorestDocumentEmitterOptions
): Promise<AutorestEmitterResult> {
  const { program, service } = context;
  const typeNameOptions: TypeNameOptions = {
    // shorten type names by removing TypeSpec and service namespace
    namespaceFilter(ns) {
      return !isService(program, ns);
    },
  };
  const info = resolveInfo(program, service.type);
  const auth = processAuth(service.type);

  const root: OpenAPI2Document = {
    swagger: "2.0",
    info: {
      title: "(title)",
      ...info,
      version: context.version ?? info?.version ?? "0000-00-00",
      "x-typespec-generated": [{ emitter: "@azure-tools/typespec-autorest" }],
    },
    schemes: ["https"],
    ...resolveHost(program, service.type),
    externalDocs: getExternalDocs(program, service.type),
    produces: [], // Pre-initialize produces and consumes so that
    consumes: [], // they show up at the top of the document
    security: auth?.security,
    securityDefinitions: auth?.securitySchemes ?? {},
    tags: [],
    paths: {},
    "x-ms-paths": {},
    definitions: {},
    parameters: {},
  };

  let currentEndpoint: OpenAPI2Operation;
  let currentConsumes: Set<string>;
  let currentProduces: Set<string>;
  const metadataInfo: MetadataInfo = createMetadataInfo(program, {
    canonicalVisibility: Visibility.Read,
    canShareProperty: canSharePropertyUsingReadonlyOrXMSMutability,
  });

  // Keep a map of all Types+Visibility combinations that were encountered
  // that need schema definitions.
  const pendingSchemas = new TwoLevelMap<Type, Visibility, PendingSchema>();

  // Reuse a single ref object per Type+Visibility combination.
  const refs = new TwoLevelMap<Type, Visibility, Ref>();

  // Keep track of inline types still in the process of having their schema computed
  // This is used to detect cycles in inline types, which is an
  const inProgressInlineTypes = new Set<Type>();

  // Map model properties that represent shared parameters to their parameter
  // definition that will go in #/parameters. Inlined parameters do not go in
  // this map.
  const params: Map<ModelProperty, OpenAPI2Parameter> = new Map();

  // Keep track of models that have had properties spread into parameters. We won't
  // consider these unreferenced when emitting unreferenced types.
  const paramModels: Set<Type> = new Set();

  // De-dupe the per-endpoint tags that will be added into the #/tags
  const tags: Set<string> = new Set();

  // The set of produces/consumes values found in all operations
  const globalProduces = new Set<string>(["application/json"]);
  const globalConsumes = new Set<string>(["application/json"]);

  const operationIdsWithExample = new Set<string>();

  const [exampleMap, diagnostics] = await loadExamples(program.host, options, context.version);
  program.reportDiagnostics(diagnostics);

  const services = ignoreDiagnostics(getAllHttpServices(program));
  const routes = services[0].operations;
  reportIfNoRoutes(program, routes);

  routes.forEach(emitOperation);

  emitParameters();
  emitSchemas(service.type);
  emitTags();

  // Finalize global produces/consumes
  if (globalProduces.size > 0) {
    root.produces = [...globalProduces.values()];
  } else {
    delete root.produces;
  }
  if (globalConsumes.size > 0) {
    root.consumes = [...globalConsumes.values()];
  } else {
    delete root.consumes;
  }

  // Clean up empty entries
  if (root["x-ms-paths"] && Object.keys(root["x-ms-paths"]).length === 0) {
    delete root["x-ms-paths"];
  }
  if (root.security && Object.keys(root.security).length === 0) {
    delete root["security"];
  }
  if (root.securityDefinitions && Object.keys(root.securityDefinitions).length === 0) {
    delete root["securityDefinitions"];
  }

  return {
    document: root,
    operationExamples: [...operationIdsWithExample]
      .map((operationId) => {
        const data = exampleMap.get(operationId);
        if (data) {
          return { operationId, examples: Object.values(data) };
        } else {
          return undefined;
        }
      })
      .filter((x) => x) as any,
  };

  function resolveHost(
    program: Program,
    namespace: Namespace
  ): Pick<OpenAPI2Document, "host" | "x-ms-parameterized-host" | "schemes"> {
    const servers = getServers(program, namespace);
    if (servers === undefined) {
      return {};
    }

    // If there is more than one server we then just make a custom host with a parameter asking for the full url.
    if (servers.length > 1) {
      return {
        "x-ms-parameterized-host": {
          hostTemplate: "{url}",
          useSchemePrefix: false,
          parameters: [
            {
              name: "url",
              in: "path",
              description: "Url",
              type: "string",
              format: "uri",
              "x-ms-skip-url-encoding": true,
            },
          ],
        },
      };
    }
    const server = servers[0];
    if (server.parameters.size === 0) {
      const [scheme, host] = server.url.split("://");
      return {
        host,
        schemes: [scheme],
      };
    }
    const parameters: OpenAPI2PathParameter[] = [];
    for (const prop of server.parameters.values()) {
      const param = getOpenAPI2Parameter(prop, "path", {
        visibility: Visibility.Read,
        ignoreMetadataAnnotations: false,
      });
      if (
        prop.type.kind === "Scalar" &&
        ignoreDiagnostics(
          program.checker.isTypeAssignableTo(
            prop.type.projectionBase ?? prop.type,
            program.checker.getStdType("url"),
            prop.type
          )
        )
      ) {
        param["x-ms-skip-url-encoding"] = true;
      }
      parameters.push(param);
    }

    return {
      "x-ms-parameterized-host": {
        hostTemplate: server.url,
        useSchemePrefix: false,
        parameters,
      },
    };
  }

  function parseNextLinkName(paged: PagedResultMetadata): string | undefined {
    const pathComponents = paged.nextLinkSegments;
    if (pathComponents) {
      return pathComponents[pathComponents.length - 1];
    }
    return undefined;
  }

  function extractPagedMetadataNested(
    program: Program,
    type: Model
  ): PagedResultMetadata | undefined {
    // This only works for `is Page<T>` not `extends Page<T>`.
    let paged = getPagedResult(program, type);
    if (paged) {
      return paged;
    }
    if (type.baseModel) {
      paged = getPagedResult(program, type.baseModel);
    }
    if (paged) {
      return paged;
    }
    const templateArguments = type.templateMapper;
    if (templateArguments) {
      for (const argument of templateArguments.args) {
        const modelArgument = argument as Model;
        if (modelArgument) {
          paged = extractPagedMetadataNested(program, modelArgument);
          if (paged) {
            return paged;
          }
        }
      }
    }
    return paged;
  }

  function extractPagedMetadata(program: Program, operation: HttpOperation) {
    for (const response of operation.responses) {
      const paged = extractPagedMetadataNested(program, response.type as Model);
      if (paged) {
        const nextLinkName = parseNextLinkName(paged);
        if (nextLinkName) {
          currentEndpoint["x-ms-pageable"] = {
            nextLinkName,
          };
        }
        // Once we find paged metadata, we don't need to processes any further.
        return;
      }
    }
  }

  function requiresXMsPaths(path: string, operation: Operation): boolean {
    const isShared = isSharedRoute(program, operation) ?? false;
    if (path.includes("?")) {
      return true;
    }
    return isShared;
  }

  function getPathWithoutQuery(path: string): string {
    // strip everything from the key including and after the ?
    return path.replace(/\/?\?.*/, "");
  }

  function emitOperation(operation: HttpOperation) {
    let { path: fullPath, operation: op, verb, parameters } = operation;
    let pathsObject: Record<string, OpenAPI2PathItem> = root.paths;

    const pathWithoutAnyQuery = getPathWithoutQuery(fullPath);

    if (root.paths[pathWithoutAnyQuery]?.[verb] === undefined) {
      fullPath = pathWithoutAnyQuery;
      pathsObject = root.paths;
    } else if (requiresXMsPaths(fullPath, op)) {
      // if the key already exists in x-ms-paths, append
      // the operation id.
      if (fullPath.includes("?")) {
        if (root["x-ms-paths"]?.[fullPath] !== undefined) {
          fullPath += `&_overload=${operation.operation.name}`;
        }
      } else {
        fullPath += `?_overload=${operation.operation.name}`;
      }
      pathsObject = root["x-ms-paths"] as any;
    } else {
      // This should not happen because http library should have already validated duplicate path or the routes must have been using shared routes and so goes in previous condition.
      compilerAssert(false, `Duplicate route "${fullPath}". This is unexpected.`);
    }

    if (!pathsObject[fullPath]) {
      pathsObject[fullPath] = {};
    }

    const currentPath = pathsObject[fullPath];
    if (!currentPath[verb]) {
      currentPath[verb] = {} as any;
    }
    currentEndpoint = currentPath[verb]!;
    currentConsumes = new Set<string>();
    currentProduces = new Set<string>();

    const currentTags = getAllTags(program, op);
    if (currentTags) {
      currentEndpoint.tags = currentTags;
      for (const tag of currentTags) {
        // Add to root tags if not already there
        tags.add(tag);
      }
    }

    currentEndpoint.operationId = resolveOperationId(context, op);

    applyExternalDocs(op, currentEndpoint);

    // Set up basic endpoint fields
    currentEndpoint.summary = getSummary(program, op);
    currentEndpoint.description = getDoc(program, op);
    currentEndpoint.parameters = [];
    currentEndpoint.responses = {};

    const lroMetadata = getLroMetadata(program, op);
    // We ignore GET operations because they cannot be LROs per our guidelines and this
    // ensures we don't add the x-ms-long-running-operation extension to the polling operation,
    // which does have LRO metadata.
    if (lroMetadata !== undefined && operation.verb !== "get") {
      currentEndpoint["x-ms-long-running-operation"] = true;
    }

    // Extract paged metadata from Azure.Core.Page
    extractPagedMetadata(program, operation);

    const visibility = resolveRequestVisibility(program, operation.operation, verb);
    emitEndpointParameters(parameters, visibility);
    emitResponses(operation.responses);
    applyEndpointConsumes();
    applyEndpointProduces();

    if (isDeprecated(program, op)) {
      currentEndpoint.deprecated = true;
    }

    const examples = getExamples(program, op);
    if (examples) {
      currentEndpoint["x-ms-examples"] = examples.reduce(
        (acc, example) => ({ ...acc, [example.title]: { $ref: example.pathOrUri } }),
        {}
      );
    }

    if (options.examplesDirectory) {
      const examples = exampleMap.get(currentEndpoint.operationId);
      if (examples && currentEndpoint.operationId) {
        operationIdsWithExample.add(currentEndpoint.operationId);
        currentEndpoint["x-ms-examples"] = currentEndpoint["x-ms-examples"] || {};
        for (const [title, example] of Object.entries(examples)) {
          currentEndpoint["x-ms-examples"][title] = { $ref: `./examples/${example.relativePath}` };
        }
      }
    }

    // Attach additional extensions after main fields
    attachExtensions(op, currentEndpoint);
  }

  function applyEndpointProduces() {
    if (currentProduces.size > 0 && !checkLocalAndGlobalEqual(globalProduces, currentProduces)) {
      currentEndpoint.produces = [...currentProduces];
    }
  }

  function applyEndpointConsumes() {
    if (currentConsumes.size > 0 && !checkLocalAndGlobalEqual(globalConsumes, currentConsumes)) {
      currentEndpoint.consumes = [...currentConsumes];
    }
  }

  function checkLocalAndGlobalEqual(global: Set<string>, local: Set<string>) {
    if (global.size !== local.size) {
      return false;
    }
    for (const entry of local) {
      if (!global.has(entry)) {
        return false;
      }
    }
    return true;
  }

  function isBytes(type: Type) {
    const baseType = type.projectionBase ?? type;
    return ignoreDiagnostics(
      program.checker.isTypeAssignableTo(baseType, program.checker.getStdType("bytes"), type)
    );
  }

  function isBinaryPayload(body: Type, contentType: string | string[]) {
    const types = new Set(typeof contentType === "string" ? [contentType] : contentType);
    return (
      body.kind === "Scalar" &&
      body.name === "bytes" &&
      !types.has("application/json") &&
      !types.has("text/plain")
    );
  }

  function emitResponses(responses: HttpOperationResponse[]) {
    for (const response of responses) {
      for (const statusCode of getOpenAPI2StatusCodes(response.statusCodes, response.type)) {
        emitResponseObject(statusCode, response);
      }
    }
  }

  function getOpenAPI2StatusCodes(
    statusCodes: HttpStatusCodesEntry,
    diagnosticTarget: DiagnosticTarget
  ): OpenAPI2StatusCode[] {
    if (statusCodes === "*") {
      return ["default"];
    } else if (typeof statusCodes === "number") {
      return [String(statusCodes)];
    } else {
      return rangeToOpenAPI(statusCodes, diagnosticTarget);
    }
  }

  function rangeToOpenAPI(
    range: HttpStatusCodeRange,
    diagnosticTarget: DiagnosticTarget
  ): OpenAPI2StatusCode[] {
    const reportInvalid = () =>
      reportDiagnostic(program, {
        code: "unsupported-status-code-range",
        format: { start: String(range.start), end: String(range.end) },
        target: diagnosticTarget,
      });

    const codes: OpenAPI2StatusCode[] = [];
    let start = range.start;
    let end = range.end;

    if (range.start < 100) {
      reportInvalid();
      start = 100;
      codes.push("default");
    } else if (range.end > 599) {
      reportInvalid();
      codes.push("default");
      end = 599;
    }
    const groups = [1, 2, 3, 4, 5];

    for (const group of groups) {
      if (start > end) {
        break;
      }
      const groupStart = group * 100;
      const groupEnd = groupStart + 99;
      if (start >= groupStart && start <= groupEnd) {
        codes.push(`${group}XX`);
        if (start !== groupStart || end < groupEnd) {
          reportInvalid();
        }

        start = groupStart + 100;
      }
    }

    return codes;
  }

  function getResponseDescriptionForStatusCode(statusCode: string) {
    if (statusCode === "default") {
      return "An unexpected error response.";
    }
    return getStatusCodeDescription(statusCode) ?? "unknown";
  }

  function emitResponseObject(statusCode: OpenAPI2StatusCode, response: HttpOperationResponse) {
    const openapiResponse: OpenAPI2Response = (currentEndpoint.responses![
      statusCode
    ] as OpenAPI2Response) ?? {
      description: response.description ?? getResponseDescriptionForStatusCode(statusCode),
    };
    if (isErrorModel(program, response.type) && statusCode !== "default") {
      openapiResponse["x-ms-error-response"] = true;
    }
    const contentTypes: string[] = [];
    let body: HttpOperationResponseBody | undefined;
    for (const data of response.responses) {
      if (data.headers && Object.keys(data.headers).length > 0) {
        openapiResponse.headers ??= {};
        for (const [key, value] of Object.entries(data.headers)) {
          openapiResponse.headers[key] = getResponseHeader(value);
        }
      }

      if (data.body) {
        if (body && body.type !== data.body.type) {
          reportDiagnostic(program, {
            code: "duplicate-body-types",
            target: response.type,
          });
        }
        body = data.body;
        contentTypes.push(...data.body.contentTypes);
      }
    }

    if (body) {
      const isBinary = contentTypes.every((t) => isBinaryPayload(body!.type, t));
      openapiResponse.schema = isBinary
        ? { type: "file" }
        : getSchemaOrRef(body.type, {
            visibility: Visibility.Read,
            ignoreMetadataAnnotations: body.isExplicit && body.containsMetadataAnnotations,
          });
    }

    for (const contentType of contentTypes) {
      currentProduces.add(contentType);
    }

    currentEndpoint.responses![statusCode] = openapiResponse;
  }

  function getResponseHeader(prop: ModelProperty): OpenAPI2HeaderDefinition {
    const header: any = {};
    populateParameter(header, prop, "header", {
      visibility: Visibility.Read,
      ignoreMetadataAnnotations: false,
    });
    delete header.in;
    delete header.name;
    delete header.required;
    return header;
  }

  function expandRef(ref: string) {
    const absoluteRef = interpolatePath(ref, {
      "arm-types-dir": options.armTypesDir,
    });

    if (getRootLength(absoluteRef) === 0) {
      return absoluteRef; // It is already relative.
    }
    return getRelativePathFromDirectory(getDirectoryPath(context.outputFile), absoluteRef, false);
  }

  function resolveExternalRef(type: Type) {
    const refUrl = getRef(program, type);
    if (refUrl) {
      return {
        $ref: expandRef(refUrl),
      };
    }

    if (isArmCommonType(type) && (type.kind === "Model" || type.kind === "ModelProperty")) {
      const ref = getArmCommonTypeOpenAPIRef(program, type, {
        version: context.version,
        service: context.service,
      });
      if (ref) {
        return {
          $ref: expandRef(ref),
        };
      }
    }
    return undefined;
  }
  function getSchemaOrRef(type: Type, schemaContext: SchemaContext): any {
    const ref = resolveExternalRef(type);
    if (ref) {
      return ref;
    }

    if (type.kind === "Scalar" && program.checker.isStdType(type)) {
      return getSchemaForScalar(type);
    }

    if (type.kind === "String" || type.kind === "Number" || type.kind === "Boolean") {
      // For literal types, we just want to emit them directly as well.
      return getSchemaForLiterals(type);
    }
    if (type.kind === "StringTemplate") {
      return getSchemaForStringTemplate(type);
    }

    if (type.kind === "Intrinsic" && type.name === "unknown") {
      return getSchemaForIntrinsicType(type);
    }

    if (type.kind === "EnumMember") {
      // Enum members are just the OA representation of their values.
      if (typeof type.value === "number") {
        return { type: "number", enum: [type.value] };
      } else {
        return { type: "string", enum: [type.value ?? type.name] };
      }
    }

    if (type.kind === "ModelProperty") {
      return resolveProperty(type, schemaContext);
    }

    type = metadataInfo.getEffectivePayloadType(type, schemaContext.visibility);
    const name = getOpenAPITypeName(program, type, typeNameOptions);

    if (shouldInline(program, type)) {
      const schema = getSchemaForInlineType(type, name, schemaContext);

      if (schema === undefined && isErrorType(type)) {
        // Exit early so that syntax errors are exposed.  This error will
        // be caught and handled in emitOpenAPI.
        throw new ErrorTypeFoundError();
      }

      // helps to read output and correlate to TypeSpec
      if (schema && options.includeXTypeSpecName !== "never") {
        schema["x-typespec-name"] = name;
      }
      return schema;
    } else {
      // Use shared schema when type is not transformed by visibility from the canonical read visibility.
      if (!metadataInfo.isTransformed(type, schemaContext.visibility)) {
        schemaContext = { ...schemaContext, visibility: Visibility.Read };
      }
      const pending = pendingSchemas.getOrAdd(type, schemaContext.visibility, () => ({
        type,
        visibility: schemaContext.visibility,
        ref: refs.getOrAdd(type, schemaContext.visibility, () => new Ref()),
      }));
      return { $ref: pending.ref };
    }
  }
  function getSchemaForInlineType(type: Type, name: string, context: SchemaContext) {
    if (inProgressInlineTypes.has(type)) {
      reportDiagnostic(program, {
        code: "inline-cycle",
        format: { type: name },
        target: type,
      });
      return {};
    }
    inProgressInlineTypes.add(type);
    const schema = getSchemaForType(type, context);
    inProgressInlineTypes.delete(type);
    return schema;
  }

  function getParamPlaceholder(property: ModelProperty): Refable<OpenAPI2Parameter> {
    let spreadParam = false;

    if (property.sourceProperty) {
      // chase our sources all the way back to the first place this property
      // was defined.
      spreadParam = true;
      property = property.sourceProperty;
      while (property.sourceProperty) {
        property = property.sourceProperty;
      }
    }

    const ref = resolveExternalRef(property);
    if (ref) {
      return ref;
    }

    const parameter = params.get(property);
    if (parameter) {
      return parameter;
    }

    const placeholder = {} as OpenAPI2Parameter;

    // only parameters inherited by spreading from non-inlined type are shared in #/parameters
    if (spreadParam && property.model && !shouldInline(program, property.model)) {
      params.set(property, placeholder);
      paramModels.add(property.model);
    }

    return placeholder;
  }

  function getJsonName(type: Type & { name: string }): string {
    const viaProjection = getProjectedName(program, type, "json");

    const encodedName = resolveEncodedName(program, type, "application/json");
    // Pick the value set via `encodedName` or default back to the legacy projection otherwise.
    // `resolveEncodedName` will return the original name if no @encodedName so we have to do that check
    return encodedName === type.name ? viaProjection ?? type.name : encodedName;
  }

  function emitEndpointParameters(methodParams: HttpOperationParameters, visibility: Visibility) {
    const consumes: string[] = methodParams.body?.contentTypes ?? [];

    for (const httpOpParam of methodParams.parameters) {
      const shared = params.get(httpOpParam.param);
      if (shared) {
        currentEndpoint.parameters.push(shared);
        continue;
      }
      if (httpOpParam.type === "header" && isContentTypeHeader(program, httpOpParam.param)) {
        continue;
      }
      emitParameter(
        httpOpParam.param,
        httpOpParam.type,
        { visibility, ignoreMetadataAnnotations: false },
        httpOpParam.name
      );
    }

    if (consumes.length === 0 && methodParams.body) {
      // we didn't find an explicit content type anywhere, so infer from body.
      if (getModelOrScalarTypeIfNullable(methodParams.body.type)) {
        consumes.push("application/json");
      }
    }

    for (const consume of consumes) {
      currentConsumes.add(consume);
    }

    if (methodParams.body && !isVoidType(methodParams.body.type)) {
      const isBinary = isBinaryPayload(methodParams.body.type, consumes);
      const schemaContext = {
        visibility,
        ignoreMetadataAnnotations:
          methodParams.body.isExplicit && methodParams.body.containsMetadataAnnotations,
      };
      const schema = isBinary
        ? { type: "string", format: "binary" }
        : getSchemaOrRef(methodParams.body.type, schemaContext);

      if (currentConsumes.has("multipart/form-data")) {
        const bodyModelType = methodParams.body.type;
        // Assert, this should never happen. Rest library guard against that.
        compilerAssert(bodyModelType.kind === "Model", "Body should always be a Model.");
        if (bodyModelType) {
          for (const param of bodyModelType.properties.values()) {
            emitParameter(param, "formData", schemaContext, getJsonName(param));
          }
        }
      } else if (methodParams.body.parameter) {
        emitParameter(
          methodParams.body.parameter,
          "body",
          { visibility, ignoreMetadataAnnotations: false },
          getJsonName(methodParams.body.parameter),
          schema
        );
      } else {
        currentEndpoint.parameters.push({
          name: "body",
          in: "body",
          schema,
          required: true,
        });
      }
    }
  }

  function getModelOrScalarTypeIfNullable(type: Type): Model | Scalar | undefined {
    if (type.kind === "Model" || type.kind === "Scalar") {
      return type;
    } else if (type.kind === "Union") {
      // Remove all `null` types and make sure there's a single model type
      const nonNulls = [...type.variants.values()]
        .map((x) => x.type)
        .filter((variant) => !isNullType(variant));
      if (nonNulls.every((t) => t.kind === "Model" || t.kind === "Scalar")) {
        return nonNulls.length === 1 ? (nonNulls[0] as Model) : undefined;
      }
    }

    return undefined;
  }

  function emitParameter(
    param: ModelProperty,
    kind: OpenAPI2ParameterType,
    schemaContext: SchemaContext,
    name?: string,
    typeOverride?: any
  ) {
    if (isNeverType(param.type)) {
      return;
    }

    const ph = getParamPlaceholder(param);
    currentEndpoint.parameters.push(ph);

    // If the parameter already has a $ref, don't bother populating it
    if (!("$ref" in ph)) {
      populateParameter(ph, param, kind, schemaContext, name, typeOverride);
    }
  }

  function getSchemaForPrimitiveItems(
    type: Type,
    schemaContext: SchemaContext,
    paramName: string,
    multipart?: boolean
  ): PrimitiveItems | undefined {
    const fullSchema = getSchemaForType(type, schemaContext);
    if (fullSchema === undefined) {
      return undefined;
    }
    if (fullSchema.type === "object") {
      reportDiagnostic(program, {
        code: multipart ? "unsupported-multipart-type" : "unsupported-param-type",
        format: { part: paramName },
        target: type,
      });
      return { type: "string" };
    }

    return fullSchema as any;
  }

  function getFormDataSchema(
    type: Type,
    schemaContext: SchemaContext,
    paramName: string
  ): Omit<OpenAPI2FormDataParameter, "in" | "name"> | undefined {
    if (isBytes(type)) {
      return { type: "file" };
    }

    if (type.kind === "Model" && isArrayModelType(program, type)) {
      const elementType = type.indexer.value;
      if (isBytes(elementType)) {
        return { type: "array", items: { type: "string", format: "binary" } };
      }
      const schema = getSchemaForPrimitiveItems(elementType, schemaContext, paramName, true);
      if (schema === undefined) {
        return undefined;
      }

      delete (schema as any).description;

      return {
        type: "array",
        items: schema,
      };
    } else {
      const schema = getSchemaForPrimitiveItems(type, schemaContext, paramName, true);

      if (schema === undefined) {
        return undefined;
      }

      return schema;
    }
  }

  function getOpenAPI2Parameter<T extends OpenAPI2ParameterType>(
    param: ModelProperty,
    kind: T,
    schemaContext: SchemaContext,
    name?: string,
    bodySchema?: any
  ): OpenAPI2Parameter & { in: T } {
    const ph: any = {
      name: name ?? param.name,
      in: kind,
      required: !param.optional,
      description: getDoc(program, param),
    };
    if (param.name !== ph.name) {
      ph["x-ms-client-name"] = param.name;
    }
    if (param.defaultValue) {
      ph.default = getDefaultValue(param.defaultValue);
    }

    if (ph.in === "body") {
      compilerAssert(bodySchema, "bodySchema argument is required to populate body parameter");
      ph.schema = bodySchema;
    } else if (ph.in === "formData") {
      Object.assign(ph, getFormDataSchema(param.type, schemaContext, ph.name));
    } else {
      const collectionFormat = (
        kind === "query"
          ? getQueryParamOptions(program, param)
          : kind === "header"
            ? getHeaderFieldOptions(program, param)
            : undefined
      )?.format;
      if (collectionFormat === "multi" && !["query", "header", "formData"].includes(ph.in)) {
        reportDiagnostic(program, { code: "invalid-multi-collection-format", target: param });
      }
      if (collectionFormat) {
        ph.collectionFormat = collectionFormat;
      }

      if (param.type.kind === "Model" && isArrayModelType(program, param.type)) {
        ph.type = "array";
        const schema = {
          ...getSchemaForPrimitiveItems(param.type.indexer.value, schemaContext, ph.name),
        };
        delete (schema as any).description;
        ph.items = schema;
      } else {
        Object.assign(ph, getSchemaForPrimitiveItems(param.type, schemaContext, ph.name));
      }
    }

    attachExtensions(param, ph);

    // Apply decorators to a copy of the parameter definition.  We use
    // Object.assign here because applyIntrinsicDecorators returns a new object
    // based on the target object and we need to apply its changes back to the
    // original parameter.
    Object.assign(ph, applyIntrinsicDecorators(param, { type: ph.type, format: ph.format }));
    return ph;
  }

  function populateParameter(
    ph: OpenAPI2Parameter,
    param: ModelProperty,
    kind: OpenAPI2ParameterType,
    schemaContext: SchemaContext,
    name?: string,
    bodySchema?: any
  ) {
    Object.assign(ph, getOpenAPI2Parameter(param, kind, schemaContext, name, bodySchema));
  }

  function emitParameters() {
    for (const [property, param] of params) {
      // Add an extension which tells AutoRest that this is a shared operation
      // parameter definition
      if (param["x-ms-parameter-location"] === undefined) {
        param["x-ms-parameter-location"] = "method";
      }

      const key = getParameterKey(program, property, param, root.parameters!, typeNameOptions);
      root.parameters![key] = { ...param };

      const refedParam = param as any;
      for (const key of Object.keys(param)) {
        delete refedParam[key];
      }

      refedParam["$ref"] = "#/parameters/" + encodeURIComponent(key);
    }
  }

  function emitSchemas(serviceNamespace: Namespace) {
    const processedSchemas = new TwoLevelMap<Type, Visibility, ProcessedSchema>();
    processSchemas();
    if (!options.omitUnreachableTypes) {
      processUnreferencedSchemas();
    }

    // Emit the processed schemas. Only now can we compute the names as it
    // depends on whether we have produced multiple schemas for a single
    // TYPESPEC type.
    for (const group of processedSchemas.values()) {
      for (const [visibility, processed] of group) {
        let name = getOpenAPITypeName(program, processed.type, typeNameOptions);
        if (group.size > 1) {
          name += getVisibilitySuffix(visibility, Visibility.Read);
        }

        checkDuplicateTypeName(program, processed.type, name, root.definitions!);
        processed.ref.value = "#/definitions/" + encodeURIComponent(name);
        if (processed.schema) {
          root.definitions![name] = processed.schema;
        }
      }
    }

    function processSchemas() {
      // Process pending schemas. Note that getSchemaForType may pull in new
      // pending schemas so we iterate until there are no pending schemas
      // remaining.
      while (pendingSchemas.size > 0) {
        for (const [type, group] of pendingSchemas) {
          for (const [visibility, pending] of group) {
            processedSchemas.getOrAdd(type, visibility, () => ({
              ...pending,
              schema: getSchemaForType(type, {
                visibility: visibility,
                ignoreMetadataAnnotations: false,
              }),
            }));
          }
          pendingSchemas.delete(type);
        }
      }
    }

    function processUnreferencedSchemas() {
      const addSchema = (type: Type) => {
        if (
          !processedSchemas.has(type) &&
          !paramModels.has(type) &&
          !shouldInline(program, type) &&
          !shouldOmitThisUnreachableType(type)
        ) {
          getSchemaOrRef(type, { visibility: Visibility.Read, ignoreMetadataAnnotations: false });
        }
      };
      const skipSubNamespaces = isGlobalNamespace(program, serviceNamespace);
      navigateTypesInNamespace(
        serviceNamespace,
        {
          model: addSchema,
          scalar: addSchema,
          enum: addSchema,
          union: addSchema,
        },
        { skipSubNamespaces }
      );
      processSchemas();
    }

    function shouldOmitThisUnreachableType(type: Type): boolean {
      if (
        options.versionEnumStrategy !== "include" &&
        type.kind === "Enum" &&
        isVersionEnum(program, type)
      ) {
        return true;
      }
      return false;
    }

    function isVersionEnum(program: Program, enumObj: Enum): boolean {
      const [_, map] = getVersionsForEnum(program, enumObj);
      if (map !== undefined && map.getVersions()[0].enumMember.enum === enumObj) {
        return true;
      }
      return false;
    }
  }

  function emitTags() {
    for (const tag of tags) {
      root.tags!.push({ name: tag });
    }
  }

  function getSchemaForType(type: Type, schemaContext: SchemaContext): OpenAPI2Schema | undefined {
    const builtinType = getSchemaForLiterals(type);
    if (builtinType !== undefined) {
      return builtinType;
    }

    switch (type.kind) {
      case "Intrinsic":
        return getSchemaForIntrinsicType(type);
      case "Model":
        return getSchemaForModel(type, schemaContext);
      case "ModelProperty":
        return getSchemaForType(type.type, schemaContext);
      case "Scalar":
        return getSchemaForScalar(type);
      case "Union":
        return getSchemaForUnion(type, schemaContext);
      case "UnionVariant":
        return getSchemaForUnionVariant(type, schemaContext);
      case "Enum":
        return getSchemaForEnum(type);
      case "Tuple":
        return { type: "array", items: {} };
    }

    reportDiagnostic(program, {
      code: "invalid-schema",
      format: { type: type.kind },
      target: type,
    });
    return undefined;
  }

  function getSchemaForIntrinsicType(type: IntrinsicType): OpenAPI2Schema {
    switch (type.name) {
      case "unknown":
        return {};
    }

    reportDiagnostic(program, {
      code: "invalid-schema",
      format: { type: type.name },
      target: type,
    });
    return {};
  }

  function getSchemaForEnum(e: Enum): OpenAPI2Schema {
    const values = [];
    if (e.members.size === 0) {
      reportUnsupportedUnion("empty");
      return {};
    }
    const type = getEnumMemberType(e.members.values().next().value);
    for (const option of e.members.values()) {
      if (type !== getEnumMemberType(option)) {
        reportUnsupportedUnion();
        continue;
      } else {
        values.push(option.value ?? option.name);
      }
    }

    const schema: OpenAPI2Schema = { type, description: getDoc(program, e) };
    if (values.length > 0) {
      schema.enum = values;
      addXMSEnum(e, schema);
    }

    if (options.useReadOnlyStatusSchema) {
      const [values, _] = extractLroStates(program, e);
      if (values !== undefined) {
        schema.readOnly = true;
      }
    }

    return schema;

    function getEnumMemberType(member: EnumMember): "string" | "number" {
      if (typeof member.value === "number") {
        return "number";
      }
      return "string";
    }

    function reportUnsupportedUnion(messageId: "default" | "empty" = "default") {
      reportDiagnostic(program, { code: "union-unsupported", messageId, target: e });
    }
  }

  function getSchemaForUnionEnum(union: Union, e: UnionEnum): OpenAPI2Schema {
    const values: Array<{
      name: string;
      value: string | number;
      description: string | undefined;
    }> = [];
    let foundCustom = false;
    for (const [name, member] of e.flattenedMembers.entries()) {
      const description = getDoc(program, member.type);
      values.push({
        name: typeof name === "string" ? name : `${member.value}`,
        value: member.value,
        description,
      });

      if (description || typeof name === "string") {
        foundCustom = true;
      }
    }
    const schema: OpenAPI2Schema = {
      type: e.kind,
      enum: [...e.flattenedMembers.values()].map((x) => x.value),
      "x-ms-enum": {
        name: union.name,
        modelAsString: e.open,
      },
    };
    if (foundCustom) {
      schema["x-ms-enum"]!.values = values;
    }
    if (e.nullable) {
      schema["x-nullable"] = true;
    }
    if (options.useReadOnlyStatusSchema) {
      const [values, _] = extractLroStates(program, union);
      if (values !== undefined) {
        schema.readOnly = true;
      }
    }
    return applyIntrinsicDecorators(union, schema);
  }

  function getSchemaForUnion(union: Union, schemaContext: SchemaContext): OpenAPI2Schema {
    const nonNullOptions = [...union.variants.values()]
      .map((x) => x.type)
      .filter((t) => !isNullType(t));
    const nullable = union.variants.size !== nonNullOptions.length;
    if (nonNullOptions.length === 0) {
      reportDiagnostic(program, { code: "union-null", target: union });
      return {};
    }

    if (nonNullOptions.length === 1) {
      const type = nonNullOptions[0];

      // Get the schema for the model type
      const schema = getSchemaOrRef(type, schemaContext);
      if (schema.$ref) {
        if (type.kind === "Model") {
          return { type: "object", allOf: [schema], "x-nullable": nullable };
        } else {
          return { ...schema, "x-nullable": nullable };
        }
      } else {
        schema["x-nullable"] = nullable;
        return schema;
      }
    } else {
      const [asEnum, _] = getUnionAsEnum(union);
      if (asEnum) {
        return getSchemaForUnionEnum(union, asEnum);
      }
      reportDiagnostic(program, {
        code: "union-unsupported",
        target: union,
      });
      return {};
    }
  }

  function ifArrayItemContainsIdentifier(program: Program, array: ArrayModelType) {
    if (array.indexer.value?.kind !== "Model") {
      return true;
    }
    return (
      getExtensions(program, array).has("x-ms-identifiers") ||
      getProperty(array.indexer.value, "id")
    );
  }

  function getSchemaForUnionVariant(
    variant: UnionVariant,
    schemaContext: SchemaContext
  ): OpenAPI2Schema {
    return getSchemaForType(variant.type, schemaContext)!;
  }

  function getDefaultValue(defaultType: Value): any {
    switch (defaultType.valueKind) {
      case "StringValue":
        return defaultType.value;
      case "NumericValue":
        return defaultType.value.asNumber() ?? undefined;
      case "BooleanValue":
        return defaultType.value;
      case "ArrayValue":
        return defaultType.values.map((x) => getDefaultValue(x));
      case "NullValue":
        return null;
      case "EnumValue":
        return defaultType.value.value ?? defaultType.value.name;
      default:
        reportDiagnostic(program, {
          code: "invalid-default",
          format: { type: defaultType.valueKind },
          target: defaultType,
        });
    }
  }

  function includeDerivedModel(model: Model): boolean {
    return (
      !isTemplateDeclaration(model) &&
      (model.templateMapper?.args === undefined ||
        model.templateMapper?.args.length === 0 ||
        model.derivedModels.length > 0)
    );
  }

  function getDiscriminatorValue(model: Model): string | undefined {
    let discriminator;
    let current = model;
    while (current.baseModel) {
      discriminator = getDiscriminator(program, current.baseModel);
      if (discriminator) {
        break;
      }
      current = current.baseModel;
    }
    if (discriminator === undefined) {
      return undefined;
    }
    const prop = getProperty(model, discriminator.propertyName);
    if (prop) {
      const values = getStringValues(prop.type);
      if (values.length === 1) {
        return values[0];
      }
    }
    return undefined;
  }

  function getSchemaForModel(model: Model, schemaContext: SchemaContext) {
    const array = getArrayType(model, schemaContext);
    if (array) {
      return array;
    }

    const modelSchema: OpenAPI2Schema = {
      type: "object",
      description: getDoc(program, model),
    };

    if (model.baseModel) {
      const discriminatorValue = getDiscriminatorValue(model);
      if (discriminatorValue) {
        const extensions = getExtensions(program, model);
        if (!extensions.has("x-ms-discriminator-value")) {
          modelSchema["x-ms-discriminator-value"] = discriminatorValue;
        }
      }
    }

    const properties: OpenAPI2Schema["properties"] = {};

    if (isRecordModelType(program, model)) {
      modelSchema.additionalProperties = getSchemaOrRef(model.indexer.value, schemaContext);
    }

    const derivedModels = model.derivedModels.filter(includeDerivedModel);

    // getSchemaOrRef on all children to push them into components.schemas
    for (const child of derivedModels) {
      getSchemaOrRef(child, schemaContext);
    }

    const discriminator = getDiscriminator(program, model);
    if (discriminator) {
      const { propertyName } = discriminator;

      modelSchema.discriminator = propertyName;
      // Push discriminator into base type, but only if it is not already there
      if (!model.properties.get(propertyName)) {
        properties[propertyName] = {
          type: "string",
          description: `Discriminator property for ${model.name}.`,
        };
        modelSchema.required = [propertyName];
      }
    }
    applySummary(model, modelSchema);
    applyExternalDocs(model, modelSchema);

    for (const prop of model.properties.values()) {
      if (
        !metadataInfo.isPayloadProperty(
          prop,
          schemaContext.visibility,
          schemaContext.ignoreMetadataAnnotations
        )
      ) {
        continue;
      }

      if (isNeverType(prop.type)) {
        // If the property has a type of 'never', don't include it in the schema
        continue;
      }

      const jsonName = getJsonName(prop);
      const clientName = getClientName(context, prop);

      const description = getDoc(program, prop);
      // if this property is a discriminator property, remove it to keep autorest validation happy
      if (model.baseModel) {
        const { propertyName } = getDiscriminator(program, model.baseModel) || {};
        if (jsonName === propertyName) {
          continue;
        }
      }

      if (
        !metadataInfo.isOptional(prop, schemaContext.visibility) ||
        prop.name === discriminator?.propertyName
      ) {
        if (!modelSchema.required) {
          modelSchema.required = [];
        }
        modelSchema.required.push(jsonName);
      }

      // Apply decorators on the property to the type's schema
      properties[jsonName] = resolveProperty(prop, schemaContext);
      const property: OpenAPI2SchemaProperty = properties[jsonName];
      if (jsonName !== clientName) {
        property["x-ms-client-name"] = clientName;
      }
      if (description) {
        property.description = description;
      }
      applySummary(prop, property);

      if (prop.defaultValue && !("$ref" in property)) {
        property.default = getDefaultValue(prop.defaultValue);
      }

      if (isReadonlyProperty(program, prop)) {
        property.readOnly = true;
      } else {
        const vis = getVisibility(program, prop);
        if (vis) {
          const mutability = [];
          if (vis.includes("read")) {
            mutability.push("read");
          }
          if (vis.includes("update")) {
            mutability.push("update");
          }
          if (vis.includes("create")) {
            mutability.push("create");
          }
          if (mutability.length > 0) {
            property["x-ms-mutability"] = mutability;
          }
        }
      }

      // Attach any additional OpenAPI extensions
      attachExtensions(prop, property);
    }

    // Special case: if a model type extends a single *templated* base type and
    // has no properties of its own, absorb the definition of the base model
    // into this schema definition.  The assumption here is that any model type
    // defined like this is just meant to rename the underlying instance of a
    // templated type.
    if (
      model.baseModel &&
      isTemplateDeclarationOrInstance(model.baseModel) &&
      Object.keys(properties).length === 0
    ) {
      // Take the base model schema but carry across the documentation property
      // that we set before
      const baseSchema = getSchemaForType(model.baseModel, schemaContext);
      Object.assign(modelSchema, baseSchema, { description: modelSchema.description });
    } else if (model.baseModel) {
      const baseSchema = getSchemaOrRef(model.baseModel, schemaContext);
      modelSchema.allOf = [baseSchema];
    }

    if (Object.keys(properties).length > 0) {
      modelSchema.properties = properties;
    }

    // Attach any OpenAPI extensions
    attachExtensions(model, modelSchema);
    return modelSchema;
  }

  function canSharePropertyUsingReadonlyOrXMSMutability(prop: ModelProperty) {
    const sharedVisibilities = ["read", "create", "update", "write"];
    const visibilities = getVisibility(program, prop);
    if (visibilities) {
      for (const visibility of visibilities) {
        if (!sharedVisibilities.includes(visibility)) {
          return false;
        }
      }
    }
    return true;
  }

  function resolveProperty(prop: ModelProperty, context: SchemaContext): OpenAPI2SchemaProperty {
    let propSchema;
    if (prop.type.kind === "Enum" && prop.defaultValue) {
      propSchema = getSchemaForEnum(prop.type);
    } else if (prop.type.kind === "Union" && prop.defaultValue) {
      const [asEnum, _] = getUnionAsEnum(prop.type);
      if (asEnum) {
        propSchema = getSchemaForUnionEnum(prop.type, asEnum);
      } else {
        propSchema = getSchemaOrRef(prop.type, context);
      }
    } else {
      propSchema = getSchemaOrRef(prop.type, context);
    }

    return applyIntrinsicDecorators(prop, propSchema);
  }

  function attachExtensions(type: Type, emitObject: any) {
    // Attach any OpenAPI extensions
    const extensions = getExtensions(program, type);
    if (getAsEmbeddingVector(program, type as Model) !== undefined) {
      emitObject["x-ms-embedding-vector"] = true;
    }
    if (type.kind === "Scalar") {
      const ext = getArmResourceIdentifierConfig(program, type);
      if (ext) {
        emitObject["x-ms-arm-id-details"] = ext;
      }
    }
    if (extensions) {
      for (const key of extensions.keys()) {
        emitObject[key] = extensions.get(key);
      }
    }
  }

  // Return any string literal values for type
  function getStringValues(type: Type): string[] {
    switch (type.kind) {
      case "String":
        return [type.value];
      case "Union":
        return [...type.variants.values()].flatMap((x) => getStringValues(x.type)).filter((x) => x);
      case "EnumMember":
        return typeof type.value !== "number" ? [type.value ?? type.name] : [];
      case "UnionVariant":
        return getStringValues(type.type);
      default:
        return [];
    }
  }

  function applyIntrinsicDecorators(
    typespecType: Model | Scalar | ModelProperty | Union,
    target: OpenAPI2Schema
  ): OpenAPI2Schema {
    const newTarget = { ...target };
    const docStr = getDoc(program, typespecType);
    const isString =
      (typespecType.kind === "Scalar" || typespecType.kind === "ModelProperty") &&
      isStringType(program, getPropertyType(typespecType));
    const isNumeric =
      (typespecType.kind === "Scalar" || typespecType.kind === "ModelProperty") &&
      isNumericType(program, getPropertyType(typespecType));

    if (docStr) {
      newTarget.description = docStr;
    }

    const title = getSummary(program, typespecType);
    if (title) {
      target.title = title;
    }

    const formatStr = getFormat(program, typespecType);
    if (isString && formatStr) {
      const allowedStringFormats = [
        "char",
        "binary",
        "byte",
        "certificate",
        "date",
        "time",
        "date-time",
        "date-time-rfc1123",
        "date-time-rfc7231",
        "duration",
        "password",
        "uuid",
        "base64url",
        "uri",
        "url",
        "arm-id",
      ];
      if (!allowedStringFormats.includes(formatStr.toLowerCase())) {
        reportDiagnostic(program, {
          code: "invalid-format",
          format: { schema: "string", format: formatStr },
          target: typespecType,
        });
      } else {
        newTarget.format = formatStr;
      }
    }

    const pattern = getPattern(program, typespecType);
    if (isString && pattern) {
      newTarget.pattern = pattern;
    }

    const minLength = getMinLength(program, typespecType);
    if (isString && minLength !== undefined) {
      newTarget.minLength = minLength;
    }

    const maxLength = getMaxLength(program, typespecType);
    if (isString && maxLength !== undefined) {
      newTarget.maxLength = maxLength;
    }

    const minValue = getMinValue(program, typespecType);
    if (isNumeric && minValue !== undefined) {
      newTarget.minimum = minValue;
    }

    const maxValue = getMaxValue(program, typespecType);
    if (isNumeric && maxValue !== undefined) {
      newTarget.maximum = maxValue;
    }

    const minItems = getMinItems(program, typespecType);
    if (!target.minItems && minItems !== undefined) {
      newTarget.minItems = minItems;
    }

    const maxItems = getMaxItems(program, typespecType);
    if (!target.maxItems && maxItems !== undefined) {
      newTarget.maxItems = maxItems;
    }

    if (isSecret(program, typespecType)) {
      newTarget.format = "password";
      newTarget["x-ms-secret"] = true;
    }

    if (isString) {
      const values = getKnownValues(program, typespecType);
      if (values) {
        const enumSchema = { ...newTarget, ...getSchemaForEnum(values) };
        enumSchema["x-ms-enum"]!.modelAsString = true;
        enumSchema["x-ms-enum"]!.name = (getPropertyType(typespecType) as Model).name;
        return enumSchema;
      }
    }

    if (
      typespecType.kind === "ModelProperty" &&
      shouldFlattenProperty(context.tcgcSdkContext, typespecType)
    ) {
      newTarget["x-ms-client-flatten"] = true;
    }

    attachExtensions(typespecType, newTarget);

    return typespecType.kind === "Scalar" || typespecType.kind === "ModelProperty"
      ? applyEncoding(typespecType, newTarget)
      : newTarget;
  }

  function applyEncoding(
    typespecType: Scalar | ModelProperty,
    target: OpenAPI2Schema
  ): OpenAPI2Schema {
    const encodeData = getEncode(program, typespecType);
    if (encodeData) {
      const newTarget = { ...target };
      const newType = getSchemaForScalar(encodeData.type);
      newTarget.type = newType.type;
      // If the target already has a format it takes priority. (e.g. int32)
      newTarget.format = mergeFormatAndEncoding(
        newTarget.format,
        encodeData.encoding,
        newType.format
      );
      return newTarget;
    }
    return target;
  }
  function mergeFormatAndEncoding(
    format: string | undefined,
    encoding: string,
    encodeAsFormat: string | undefined
  ): string {
    switch (format) {
      case undefined:
        return encodeAsFormat ?? encoding;
      case "date-time":
        switch (encoding) {
          case "rfc3339":
            return "date-time";
          case "unixTimestamp":
            return "unixtime";
          case "rfc7231":
            return "date-time-rfc7231";
          default:
            return encoding;
        }
      case "duration":
        switch (encoding) {
          case "ISO8601":
            return "duration";
          default:
            return encodeAsFormat ?? encoding;
        }
      default:
        return encodeAsFormat ?? encoding;
    }
  }

  function applySummary(typespecType: Type, target: { title?: string }) {
    const summary = getSummary(program, typespecType);
    if (summary) {
      target.title = summary;
    }
  }
  function applyExternalDocs(typespecType: Type, target: Record<string, unknown>) {
    const externalDocs = getExternalDocs(program, typespecType);
    if (externalDocs) {
      target.externalDocs = externalDocs;
    }
  }

  function addXMSEnum(type: StringLiteral | Union | Enum, schema: OpenAPI2Schema): OpenAPI2Schema {
    if (type.node && type.node.parent && type.node.parent.kind === SyntaxKind.ModelStatement) {
      schema["x-ms-enum"] = {
        name: type.node.parent.id.sv,
        modelAsString: true,
      };
    } else if (type.kind === "String") {
      schema["x-ms-enum"] = {
        modelAsString: false,
      };
    } else if (type.kind === "Enum") {
      schema["x-ms-enum"] = {
        name: type.name,
        modelAsString: isFixed(program, type) ? false : true,
      };

      const values = [];
      let foundCustom = false;
      for (const member of type.members.values()) {
        const description = getDoc(program, member);
        values.push({
          name: member.name,
          value: member.value ?? member.name,
          description,
        });

        if (description || member.value !== undefined) {
          foundCustom = true;
        }
      }
      if (foundCustom) {
        schema["x-ms-enum"].values = values;
      }
    }

    return schema;
  }

  function getSchemaForStringTemplate(stringTemplate: StringTemplate) {
    if (stringTemplate.stringValue === undefined) {
      program.reportDiagnostics(
        explainStringTemplateNotSerializable(stringTemplate).map((x) => ({
          ...x,
          severity: "warning",
        }))
      );
      return { type: "string" };
    }
    return { type: "string", enum: [stringTemplate.stringValue] };
  }
  // Map an TypeSpec type to an OA schema. Returns undefined when the resulting
  // OA schema is just a regular object schema.
  function getSchemaForLiterals(
    typespecType: NumericLiteral | StringLiteral | BooleanLiteral
  ): OpenAPI2Schema;
  function getSchemaForLiterals(typespecType: Type): OpenAPI2Schema | undefined;
  function getSchemaForLiterals(typespecType: Type): OpenAPI2Schema | undefined {
    switch (typespecType.kind) {
      case "Number":
        return { type: "number", enum: [typespecType.value] };
      case "String":
        return addXMSEnum(typespecType, { type: "string", enum: [typespecType.value] });
      case "Boolean":
        return { type: "boolean", enum: [typespecType.value] };
      default:
        return undefined;
    }
  }

  /**
   * If the model is an array model return the OpenAPI2Schema for the array type.
   */
  function getArrayType(typespecType: Model, context: SchemaContext): OpenAPI2Schema | undefined {
    if (isArrayModelType(program, typespecType)) {
      const array: OpenAPI2Schema = {
        type: "array",
        items: getSchemaOrRef(typespecType.indexer.value!, {
          ...context,
          visibility: context.visibility | Visibility.Item,
        }),
      };
      if (!ifArrayItemContainsIdentifier(program, typespecType as any)) {
        array["x-ms-identifiers"] = [];
      }
      return applyIntrinsicDecorators(typespecType, array);
    }
    return undefined;
  }

  function getSchemaForScalar(scalar: Scalar): OpenAPI2Schema {
    let result: OpenAPI2Schema = {};
    const isStd = program.checker.isStdType(scalar);
    if (isStd) {
      result = getSchemaForStdScalars(scalar);
    } else if (scalar.baseScalar) {
      result = getSchemaForScalar(scalar.baseScalar);
    }
    const withDecorators = applyIntrinsicDecorators(scalar, result);
    if (isStd) {
      // Standard types are going to be inlined in the spec and we don't want the description of the scalar to show up
      delete withDecorators.description;
    }
    return withDecorators;
  }

  function getSchemaForStdScalars(scalar: Scalar & { name: IntrinsicScalarName }): OpenAPI2Schema {
    function reportNonspecificScalar(scalarName: string, chosenScalarName: string): void {
      reportDiagnostic(program, {
        code: "nonspecific-scalar",
        format: { type: scalarName, chosenType: chosenScalarName },
        target: scalar,
      });
    }

    switch (scalar.name) {
      case "bytes":
        return { type: "string", format: "byte" };
      case "numeric":
        reportNonspecificScalar("numeric", "int64");
        return { type: "integer", format: "int64" };
      case "integer":
        reportNonspecificScalar("integer", "int64");
        return { type: "integer", format: "int64" };
      case "int8":
        return { type: "integer", format: "int8" };
      case "int16":
        return { type: "integer", format: "int16" };
      case "int32":
        return { type: "integer", format: "int32" };
      case "int64":
        return { type: "integer", format: "int64" };
      case "safeint":
        return { type: "integer", format: "int64" };
      case "uint8":
        return { type: "integer", format: "uint8" };
      case "uint16":
        return { type: "integer", format: "uint16" };
      case "uint32":
        return { type: "integer", format: "uint32" };
      case "uint64":
        return { type: "integer", format: "uint64" };
      case "float":
        reportNonspecificScalar("float", "float64");
        return { type: "number" };
      case "float64":
        return { type: "number", format: "double" };
      case "float32":
        return { type: "number", format: "float" };
      case "decimal":
        return { type: "number", format: "decimal" };
      case "decimal128":
        return { type: "number", format: "decimal" };
      case "string":
        return { type: "string" };
      case "boolean":
        return { type: "boolean" };
      case "plainDate":
        return { type: "string", format: "date" };
      case "utcDateTime":
      case "offsetDateTime":
        return { type: "string", format: "date-time" };
      case "plainTime":
        return { type: "string", format: "time" };
      case "duration":
        return { type: "string", format: "duration" };
      case "url":
        return { type: "string", format: "uri" };
      default:
        const _assertNever: never = scalar.name;
        return {};
    }
  }

  function processAuth(serviceNamespace: Namespace):
    | {
        securitySchemes: Record<string, OpenAPI2SecurityScheme>;
        security: Record<string, string[]>[];
      }
    | undefined {
    const authentication = getAuthentication(program, serviceNamespace);
    if (authentication) {
      return processServiceAuthentication(authentication, serviceNamespace);
    }
    return undefined;
  }

  function processServiceAuthentication(
    authentication: Authentication,
    serviceNamespace: Namespace
  ): {
    securitySchemes: Record<string, OpenAPI2SecurityScheme>;
    security: Record<string, string[]>[];
  } {
    const oaiSchemes: Record<string, OpenAPI2SecurityScheme> = {};
    const security: Record<string, string[]>[] = [];
    for (const option of authentication.options) {
      const oai3SecurityOption: Record<string, string[]> = {};
      for (const scheme of option.schemes) {
        const result = getOpenAPI2Scheme(scheme, serviceNamespace);
        if (result !== undefined) {
          const [oaiScheme, scopes] = result;
          oaiSchemes[scheme.id] = oaiScheme;
          oai3SecurityOption[scheme.id] = scopes;
        }
      }

      if (Object.keys(oai3SecurityOption).length > 0) {
        security.push(oai3SecurityOption);
      }
    }
    return { securitySchemes: oaiSchemes, security };
  }

  function getOpenAPI2Scheme(
    auth: HttpAuth,
    serviceNamespace: Namespace
  ): [OpenAPI2SecurityScheme, string[]] | undefined {
    switch (auth.type) {
      case "http":
        if (auth.scheme !== "basic") {
          reportDiagnostic(program, {
            code: "unsupported-http-auth-scheme",
            target: serviceNamespace,
            format: { scheme: auth.scheme },
          });
          return undefined;
        }
        return [{ type: "basic", description: auth.description }, []];
      case "apiKey":
        if (auth.in === "cookie") {
          return undefined;
        }
        return [
          { type: "apiKey", description: auth.description, in: auth.in, name: auth.name },
          [],
        ];
      case "oauth2":
        const flow = auth.flows[0];
        if (flow === undefined) {
          return undefined;
        }
        const oaiFlowName = getOpenAPI2Flow(flow.type);
        return [
          {
            type: "oauth2",
            description: auth.description,
            flow: oaiFlowName,
            authorizationUrl: (flow as any).authorizationUrl,
            tokenUrl: (flow as any).tokenUrl,
            scopes: Object.fromEntries(flow.scopes.map((x) => [x.value, x.description ?? ""])),
          } as any,
          flow.scopes.map((x) => x.value),
        ];
      case "openIdConnect":
      default:
        reportDiagnostic(program, {
          code: "unsupported-auth",
          format: { authType: (auth as any).type },
          target: service.type,
        });
        return undefined;
    }
  }

  function getOpenAPI2Flow(flow: OAuth2FlowType): OpenAPI2OAuth2FlowType {
    switch (flow) {
      case "authorizationCode":
        return "accessCode";
      case "clientCredentials":
        return "application";
      case "implicit":
        return "implicit";
      case "password":
        return "password";
      default:
        const _assertNever: never = flow;
        compilerAssert(false, "Unreachable");
    }
  }
}

class ErrorTypeFoundError extends Error {
  constructor() {
    super("Error type found in evaluated TypeSpec output");
  }
}

export function sortOpenAPIDocument(doc: OpenAPI2Document): OpenAPI2Document {
  // Doing this to make sure the classes with toJSON are resolved.
  const unsorted = JSON.parse(JSON.stringify(doc));
  const sorted = sortWithJsonSchema(
    unsorted,
    AutorestOpenAPISchema,
    "#/$defs/AutorestOpenAPISchema"
  );
  return sorted;
}

interface LoadedExample {
  readonly relativePath: string;
  readonly file: SourceFile;
  readonly data: any;
}
async function loadExamples(
  host: CompilerHost,
  options: AutorestDocumentEmitterOptions,
  version?: string
): Promise<[Map<string, Record<string, LoadedExample>>, readonly Diagnostic[]]> {
  const diagnostics = createDiagnosticCollector();
  if (!options.examplesDirectory) {
    return diagnostics.wrap(new Map());
  }
  const exampleDir = version
    ? resolvePath(options.examplesDirectory, version)
    : resolvePath(options.examplesDirectory);
  try {
    if (!(await host.stat(exampleDir)).isDirectory()) return diagnostics.wrap(new Map());
  } catch (err) {
    diagnostics.add(
      createDiagnostic({
        code: "example-loading",
        messageId: "noDirectory",
        format: { directory: exampleDir },
        target: NoTarget,
      })
    );
    return diagnostics.wrap(new Map());
  }
  const map = new Map<string, Record<string, LoadedExample>>();
  const exampleFiles = await host.readDir(exampleDir);
  for (const fileName of exampleFiles) {
    try {
      const exampleFile = await host.readFile(resolvePath(exampleDir, fileName));
      const example = JSON.parse(exampleFile.text);
      if (!example.operationId || !example.title) {
        diagnostics.add(
          createDiagnostic({
            code: "example-loading",
            messageId: "noOperationId",
            format: { filename: fileName },
            target: NoTarget,
          })
        );
        continue;
      }

      if (!map.has(example.operationId)) {
        map.set(example.operationId, {});
      }
      const examples = map.get(example.operationId)!;

      if (example.title in examples) {
        diagnostics.add(
          createDiagnostic({
            code: "duplicate-example-file",
            target: NoTarget,
            format: {
              filename: fileName,
              operationId: example.operationId,
              title: example.title,
            },
          })
        );
      }

      examples[example.title] = {
        relativePath: fileName,
        file: exampleFile,
        data: example,
      };
    } catch (err) {
      diagnostics.add(
        createDiagnostic({
          code: "example-loading",
          messageId: "default",
          format: { filename: fileName, error: err?.toString() ?? "" },
          target: NoTarget,
        })
      );
    }
  }
  return diagnostics.wrap(map);
}
