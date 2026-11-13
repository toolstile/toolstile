CREATE TABLE "source_namespaces" (
	"scopeId" text NOT NULL,
	"namespace" text NOT NULL,
	"sourceId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_namespaces_scopeId_namespace_pk" PRIMARY KEY("scopeId","namespace"),
	CONSTRAINT "source_namespaces_sourceId_unique" UNIQUE("sourceId")
);
