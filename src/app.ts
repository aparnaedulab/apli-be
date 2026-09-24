import { join, resolve } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { databaseConnection, env, isProduction } from './config/env.js';
import { requireAuth } from './middleware/auth.js';
import { asyncHandler, errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { prisma } from './lib/prisma.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { collegesRouter } from './modules/admin/colleges.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { campusRouter } from './modules/campus/campus.routes.js';
import { candidateRouter } from './modules/candidates/candidate.routes.js';
import { placementsRouter } from './modules/campus/placements.routes.js';
import { postingsRouter } from './modules/campus/postings.routes.js';
import { campusTeamRouter } from './modules/campus/team.routes.js';
import { companiesRouter } from './modules/admin/companies.routes.js';
import { collegeTypesRouter } from './modules/admin/collegeTypes.routes.js';
import { coursesRouter } from './modules/admin/courses.routes.js';
import { referenceRouter } from './modules/admin/reference.routes.js';
import { skillsRouter } from './modules/admin/skills.routes.js';
import { catalogueRouter } from './modules/admin/catalogue.routes.js';
import { industriesRouter } from './modules/admin/industries.routes.js';
import { rolesRouter } from './modules/roles/roles.routes.js';
import { accessRouter } from './modules/roles/access.routes.js';
import { companyRouter } from './modules/company/company.routes.js';
import { jobRouter } from './modules/jobs/job.routes.js';
import { studentJobsRouter } from './modules/candidates/studentJobs.routes.js';
import { applicationRouter } from './modules/applications/application.routes.js';
import { feedRouter } from './modules/feed/feed.routes.js';
import {
  campusCounsellingRouter,
  counsellingRouter,
} from './modules/counselling/counselling.routes.js';
import {
  candidateAssessmentRouter,
  companyAssessmentRouter,
} from './modules/assessments/assessment.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';
import { noticeRouter } from './modules/notices/notice.routes.js';
import {
  campusDrivesRouter,
  candidateDrivesRouter,
  companyDrivesRouter,
} from './modules/campusDrives/drive.routes.js';
import { platformRouter } from './modules/tenants/platform.routes.js';
import { filesRouter } from './modules/tenants/assets.js';
import { trustRouter } from './modules/trust/trust.routes.js';
import { trackerRouter } from './modules/tracker/tracker.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { consentRouter } from './modules/consent/consent.routes.js';
import { companyPageRouter } from './modules/showcase/companyPage.routes.js';
import { companyPostsRouter } from './modules/showcase/companyPosts.routes.js';
import { internshipRouter } from './modules/internships/internship.routes.js';
import { practiceRouter } from './modules/practice/practice.routes.js';
import { mockInterviewRouter } from './modules/mockInterview/mockInterview.routes.js';
import { proofRouter } from './modules/proof/proof.routes.js';
import { communityRouter } from './modules/community/community.routes.js';
import { opsRouter } from './modules/ops/ops.routes.js';
import { afterOfferRouter } from './modules/afterOffer/afterOffer.routes.js';
import { growthRouter } from './modules/growth/growth.routes.js';
import { opportunitiesRouter } from './modules/opportunities/opportunities.routes.js';
import { networkRouter } from './modules/network/network.routes.js';
import { insightsRouter } from './modules/insights/insights.routes.js';
import { localeRouter } from './modules/locale/locale.routes.js';
import { platformBulkRouter } from './modules/tenants/bulk.routes.js';
import { publicTenantRouter } from './modules/publicTenant/publicTenant.routes.js';
import { companyAccessRouter } from './modules/companyAccess/companyAccess.routes.js';
import { institutionRulesRouter } from './modules/admin/institutionRules.routes.js';
import {
  adminMappingRouter,
  campusMappingRouter,
  platformMappingRouter,
} from './modules/mapping/mapping.routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(morgan(isProduction ? 'combined' : 'dev'));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // The React client runs on its own origin, so cookies must be allowed
  // through explicitly. Only our client origin, and only with credentials.
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );

  // The session table is created by a Prisma migration, not at runtime, so the
  // store is told not to make its own and is pointed at our column names.
  const MySQLStore = MySQLStoreFactory(session);
  app.use(
    session({
      store: new MySQLStore({
        ...databaseConnection(),
        // The table comes from a Prisma migration, so the store must not try
        // to create its own - and it is told our column names.
        createDatabaseTable: false,
        schema: {
          tableName: 'user_sessions',
          columnNames: { session_id: 'sid', expires: 'expire', data: 'sess' },
        },
      }),
      name: 'campus.sid',
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.COOKIE_SECURE ?? isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 7, // one week
      },
    }),
  );

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  const api = express.Router();

  // Default deny. Everything below this line needs a session unless it is
  // named in the PUBLIC_ROUTES allowlist in middleware/auth.ts.
  api.use(requireAuth);

  api.get(
    '/health',
    asyncHandler(async (_req: Request, res: Response) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        service: 'apli-server',
        environment: env.NODE_ENV,
        database: 'connected',
        time: new Date().toISOString(),
      });
    }),
  );

  api.use('/auth', authRouter);
  api.use('/notifications', notificationRouter);
  // Institution notices. The GET is open to every role - the router decides
  // who a notice was addressed to - and everything that writes is ADMIN only.
  api.use('/notices', noticeRouter);
  // Before /platform, so the bulk router's own guards apply to its paths.
  api.use('/platform/bulk', platformBulkRouter);
  api.use('/platform/tenants/:tenantId/mapping', platformMappingRouter);
  api.use('/platform', platformRouter);
  api.use('/public', publicTenantRouter);
  api.use('/company-access', companyAccessRouter);
  api.use('/files', filesRouter);
  // Phase 1, the trust core. Each router fences itself (role, module, scope).
  api.use('/trust', trustRouter);
  api.use('/tracker', trackerRouter);
  api.use('/reports', reportsRouter);
  api.use('/consent', consentRouter);
  // Before /company, so the posts router's own guards apply to its paths.
  api.use('/company/posts', companyPostsRouter);
  api.use('/showcase', companyPageRouter);
  // Phase 2 - proof of work, preparation and placement-cell tools.
  api.use('/internships', internshipRouter);
  api.use('/practice', practiceRouter);
  api.use('/mock-interviews', mockInterviewRouter);
  api.use('/proof', proofRouter);
  api.use('/community', communityRouter);
  api.use('/ops', opsRouter);
  // Phase 3 - after the offer, deeper practice, opportunities, network, insight, reach.
  api.use('/after-offer', afterOfferRouter);
  api.use('/growth', growthRouter);
  api.use('/opportunities', opportunitiesRouter);
  api.use('/network', networkRouter);
  api.use('/insights', insightsRouter);
  api.use('/locale', localeRouter);
  api.use('/admin/colleges', collegesRouter);
  api.use('/admin/companies', companiesRouter);
  api.use('/admin/college-types', collegeTypesRouter);
  api.use('/admin/courses', coursesRouter);
  api.use('/admin/reference', referenceRouter);
  api.use('/admin/skills', skillsRouter);
  api.use('/catalogue', catalogueRouter);
  api.use('/admin/industries', industriesRouter);
  api.use('/admin/roles', rolesRouter);
  api.use('/admin/access', accessRouter);
  // Before /admin, so its own guards apply to its paths.
  api.use('/admin/institution-rules', institutionRulesRouter);
  api.use('/admin/mapping', adminMappingRouter);
  api.use('/admin', adminRouter);
  api.use('/campus/placements', placementsRouter);
  // College-invited drives. Three doors onto one thing: the cell arranges
  // it, the company answers it, the student puts a name down for it.
  api.use('/campus/drives', campusDrivesRouter);
  api.use('/company/drives', companyDrivesRouter);
  api.use('/candidate/drives', candidateDrivesRouter);
  api.use('/campus/postings', postingsRouter);
  api.use('/campus/team', campusTeamRouter);
  api.use('/campus/mapping', campusMappingRouter);
  api.use('/campus', campusRouter);
  api.use('/candidate/jobs', studentJobsRouter);
  api.use('/candidate/assessments', candidateAssessmentRouter);
  api.use('/feed', feedRouter);
  api.use('/candidate/counselling', counsellingRouter);
  api.use('/campus/counselling', campusCounsellingRouter);
  api.use('/candidate', candidateRouter);
  api.use('/company/jobs', jobRouter);
  api.use('/company/applications', applicationRouter);
  api.use('/company/assessments', companyAssessmentRouter);
  api.use('/company', companyRouter);

  // Feature routers mount here as each milestone lands:
  //   api.use('/candidates', candidateRouter);   M5
  //   api.use('/batches', batchRouter);          M4
  //   api.use('/placements', placementRouter);   M6
  //   api.use('/jobs', jobRouter);               M7
  //   api.use('/applications', applicationRouter); M8

  app.use('/api', api);

  /*
   * Serve the built client from this process, when asked to.
   *
   * Mounted after /api so it can never shadow a route, and before the 404 so
   * a deep link still lands: a single-page app owns its own routing, and a
   * reader who refreshes on /student/profile must get index.html rather than
   * this server's idea of a missing page. Anything under /api that got this
   * far really is missing, so it keeps the JSON 404 it always had.
   */
  if (env.CLIENT_DIST) {
    const dist = resolve(env.CLIENT_DIST);
    // Hashed assets never change under the same name, so they are cached hard;
    // index.html is the one file that must not be, or a deploy is invisible
    // until everybody clears their browser.
    app.use(express.static(dist, { index: false, maxAge: '1y' }));
    app.get(/^\/(?!api\/).*/, (_req, res, next) => {
      res.sendFile(join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-store' } }, (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
