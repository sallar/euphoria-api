export declare const betterAuth: import("better-auth").Auth<{
    database: (options: import("better-auth").BetterAuthOptions) => import("better-auth").DBAdapter<import("better-auth").BetterAuthOptions>;
    emailAndPassword: {
        enabled: true;
    };
    plugins: [{
        id: "open-api";
        version: string;
        endpoints: {
            generateOpenAPISchema: import("better-call").StrictEndpoint<"/open-api/generate-schema", {
                method: "GET";
            }, {
                openapi: string;
                info: {
                    title: string;
                    description: string;
                    version: string;
                };
                components: {
                    securitySchemes: {
                        apiKeyCookie: {
                            type: string;
                            in: string;
                            name: string;
                            description: string;
                        };
                        bearerAuth: {
                            type: string;
                            scheme: string;
                            description: string;
                        };
                    };
                    schemas: {
                        [x: string]: import("better-auth/plugins").OpenAPIModelSchema;
                    };
                };
                security: {
                    apiKeyCookie: never[];
                    bearerAuth: never[];
                }[];
                servers: {
                    url: string;
                }[];
                tags: {
                    name: string;
                    description: string;
                }[];
                paths: Record<string, import("better-auth/plugins").Path>;
            }>;
            openAPIReference: import("better-call").StrictEndpoint<import("better-auth").LiteralString | "/reference", {
                method: "GET";
                metadata: {
                    readonly scope: "server";
                };
            }, Response>;
        };
        options: NoInfer<import("better-auth/plugins").OpenAPIOptions>;
    }, {
        id: "expo";
        version: string;
        init: (ctx: import("better-auth").AuthContext) => {
            options: {
                trustedOrigins: string[];
            };
        };
        onRequest(request: Request, ctx: import("better-auth").AuthContext): Promise<{
            request: Request;
        } | undefined>;
        hooks: {
            after: {
                matcher(context: import("better-auth").HookEndpointContext): boolean;
                handler: (inputContext: import("better-call").MiddlewareInputContext<import("better-call").MiddlewareOptions>) => Promise<void>;
            }[];
        };
        endpoints: {
            expoAuthorizationProxy: import("better-call").StrictEndpoint<"/expo-authorization-proxy", {
                method: "GET";
                query: import("zod").ZodObject<{
                    authorizationURL: import("zod").ZodString;
                    oauthState: import("zod").ZodOptional<import("zod").ZodString>;
                }, import("zod/v4/core").$strip>;
                metadata: {
                    readonly scope: "server";
                };
            }, {
                status: ("OK" | "CREATED" | "ACCEPTED" | "NO_CONTENT" | "MULTIPLE_CHOICES" | "MOVED_PERMANENTLY" | "FOUND" | "SEE_OTHER" | "NOT_MODIFIED" | "TEMPORARY_REDIRECT" | "BAD_REQUEST" | "UNAUTHORIZED" | "PAYMENT_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "NOT_ACCEPTABLE" | "PROXY_AUTHENTICATION_REQUIRED" | "REQUEST_TIMEOUT" | "CONFLICT" | "GONE" | "LENGTH_REQUIRED" | "PRECONDITION_FAILED" | "PAYLOAD_TOO_LARGE" | "URI_TOO_LONG" | "UNSUPPORTED_MEDIA_TYPE" | "RANGE_NOT_SATISFIABLE" | "EXPECTATION_FAILED" | "I'M_A_TEAPOT" | "MISDIRECTED_REQUEST" | "UNPROCESSABLE_ENTITY" | "LOCKED" | "FAILED_DEPENDENCY" | "TOO_EARLY" | "UPGRADE_REQUIRED" | "PRECONDITION_REQUIRED" | "TOO_MANY_REQUESTS" | "REQUEST_HEADER_FIELDS_TOO_LARGE" | "UNAVAILABLE_FOR_LEGAL_REASONS" | "INTERNAL_SERVER_ERROR" | "NOT_IMPLEMENTED" | "BAD_GATEWAY" | "SERVICE_UNAVAILABLE" | "GATEWAY_TIMEOUT" | "HTTP_VERSION_NOT_SUPPORTED" | "VARIANT_ALSO_NEGOTIATES" | "INSUFFICIENT_STORAGE" | "LOOP_DETECTED" | "NOT_EXTENDED" | "NETWORK_AUTHENTICATION_REQUIRED") | import("better-call").Status;
                body: ({
                    message?: string;
                    code?: string;
                    cause?: unknown;
                } & Record<string, any>) | undefined;
                headers: HeadersInit;
                statusCode: number;
                name: string;
                message: string;
                stack?: string;
                cause?: unknown;
            }>;
        };
        options: import("@better-auth/expo").ExpoOptions | undefined;
    }, {
        id: "bearer";
        version: string;
        hooks: {
            before: {
                matcher(context: import("better-auth").HookEndpointContext): boolean;
                handler: (inputContext: import("better-call").MiddlewareInputContext<import("better-call").MiddlewareOptions>) => Promise<{
                    context: {
                        headers: Headers;
                    };
                } | undefined>;
            }[];
            after: {
                matcher(context: import("better-auth").HookEndpointContext): true;
                handler: (inputContext: import("better-call").MiddlewareInputContext<import("better-call").MiddlewareOptions>) => Promise<void>;
            }[];
        };
        options: import("better-auth/plugins").BearerOptions | undefined;
    }];
    trustedOrigins: string[];
}>;
export declare const OpenAPI: {
    readonly getPaths: (prefix?: string) => Promise<any>;
    readonly components: Promise<any>;
};
