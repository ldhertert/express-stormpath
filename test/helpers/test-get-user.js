'use strict';

var assert = require('assert');

var Cookies = require('cookies');
var async = require('async');
var cookieParser = require('cookie-parser');
var deepExtend = require('deep-extend');
var express = require('express');
var request = require('supertest');
var uuid = require('uuid');
var winston = require('winston');

var getToken = require('../../lib/controllers/get-token');
var getUser = require('../../lib/helpers/get-user');
var helpers = require('../helpers');
var login = require('../../lib/controllers/login');
var stormpath = require('../../index');

describe('getUser', function() {
  var username = 'test+' + uuid.v4() + '@stormpath.com';
  var password = uuid.v4() + uuid.v4().toUpperCase();
  var accountData = {
    email: username,
    password: password,
    givenName: uuid.v4(),
    surname: uuid.v4()
  };
  var stormpathAccount;
  var stormpathApiKey;
  var stormpathApplication;
  var stormpathClient;

  /**
   * This callback, when called, will continue processing the http request.
   *
   * @callback middlewareCallback
   *
   * @param {Object} req - The http request.
   * @param {Object} res - The http response.
   * @param {Function} [next] - The next middleware to run.
   */

  /**
   * Fakes initializing the stormpath.init middleware -- it attaches some objects
   * to req.app, which helps us test our middlewares in a more isolated
   * environment.
   *
   * @param {Object} app - The Express application object.
   * @returns {middlewareCallback} - The Express middleware which runs when
   *    used.
   */
  function fakeInit(app) {
    var defaultConfig = require('stormpath/lib/config.json');

    var config = deepExtend({},defaultConfig);

    deepExtend(config, {
      application: {
        href: stormpathApplication.href
      },
      expand: {
        customData: true
      },
      web: {
        login: {
          enabled: true
        }
      }
    });

    app.set('stormpathApplication', stormpathApplication);
    app.set('stormpathClient', stormpathClient);
    app.set('stormpathLogger', new winston.Logger({
      transports: [
        new winston.transports.Console({
          colorize: true,
          level: 'error'
        })
      ]
    }));
    app.set('stormpathConfig', config);

    app.use(cookieParser());
    return function(req, res, next) {
      req.app = app;
      next();
    };
  }

  /**
   * Create and return a fake Express app in an isolated environment.
   *
   * @returns {Object} - An initialized Express application object.
   */
  function createFakeExpressApp() {
    var app = express();

    app.use(fakeInit(app));
    return app;
  }

  /**
   * This route creates a cookie, then returns a 200.  Used for testing auth in
   * a more isolated environment.
   *
   * @param {String} cookieName - The cookie name to set.
   * @param {String} cookieValue - The cookie value to set.
   * @returns {middlewareCallback} - The Express middleware which runs when
   *    used.
   */
  function createCookieRoute(cookieName, cookieValue) {
    return function(req, res, next) {
      var cookies = new Cookies(req, res);
      cookies.set(cookieName, cookieValue, { overwrite: true });
      res.status(200).end();
    };
  }

  before(function(done) {
    stormpathClient = helpers.createClient();
    helpers.createApplication(stormpathClient, function(err, app) {
      if (err) {
        return done(err);
      }

      stormpathApplication = app;
      app.createAccount(accountData, function(err, account) {
        if (err) {
          return done(err);
        }

        stormpathAccount = account;
        stormpathAccount.createApiKey(function(err, key) {
          if (err) {
            return done(err);
          }

          stormpathApiKey = key;
          done();
        });
      });
    });
  });

  after(function(done) {
    helpers.destroyApplication(stormpathApplication, done);
  });

  it('should continue immediately if req.user is already defined', function(done) {
    var app = createFakeExpressApp();

    function fakeReqUser(req, res, next) {
      req.user = 'blah';
      next();
    }

    app.get('/', fakeReqUser, getUser, function(req, res) {
      res.json({ user: req.user });
    });

    request(app)
      .get('/')
      .expect(200)
      .end(function(err, res) {
        if (err) {
          return done(err);
        }

        var json = JSON.parse(res.text);
        assert.equal(json.user, 'blah');
        done();
      });
  });

  it('should continue immediately if req.cookies.idSiteSession is an invalid accountHref', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    function ensureNoUserExists(req, res, next) {
      assert.equal(req.user, undefined);
      next();
    }

    app.get('/setBadCookie', createCookieRoute('idSiteSession', 'INVALID_ACCOUNT_HREF'));
    app.get('/', getUser, ensureNoUserExists, function(req, res) {
      res.send('success');
    });

    async.series([
      function(callback) {
        agent
          .get('/setBadCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if req.cookies.idSiteSession is a non-enabled accountHref', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    function ensureNoUserExists(req, res, next) {
      assert.equal(req.user, undefined);
      next();
    }

    app.get('/setCookie', createCookieRoute('idSiteSession', stormpathAccount.href));
    app.get('/', getUser, ensureNoUserExists, function(req, res) {
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'DISABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should set req.user and res.locals.user if req.cookies.idSiteSession is a valid accountHref', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    function ensureUserExists(req, res, next) {
      assert.equal(req.user.givenName, stormpathAccount.givenName);
      assert.equal(req.user.surname, stormpathAccount.surname);
      assert.equal(req.user.email, stormpathAccount.email);
      assert.equal(res.locals.user.givenName, stormpathAccount.givenName);
      assert.equal(res.locals.user.surname, stormpathAccount.surname);
      assert.equal(res.locals.user.email, stormpathAccount.email);

      next();
    }

    app.get('/setCookie', createCookieRoute('idSiteSession', stormpathAccount.href));
    app.get('/', getUser, ensureUserExists, function(req, res) {
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should expand customData if req.cookies.idSiteSession is valid', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/setCookie', createCookieRoute('idSiteSession', stormpathAccount.href));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if no cookies are present', function(done) {
    var app = createFakeExpressApp();

    app.get('/', getUser, function(req, res) {
      res.json({ user: req.user });
    });

    request(app)
      .get('/')
      .expect(200)
      .end(function(err, res) {
        if (err) {
          return done(err);
        }

        var json = JSON.parse(res.text);
        assert.equal(json.user, null);
        done();
      });
  });

  it('should continue immediately if an invalid access_token cookie is present, and no refresh_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/setCookie', createCookieRoute('access_token', 'blah'));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if a disabled account\'s access_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        stormpathAccount.status = 'DISABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if a disabled account\'s access_token cookie is invalid but who\'s refresh_token cookie is valid', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/setCookie', createCookieRoute('access_token', 'hiii'));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        stormpathAccount.status = 'DISABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if a disabled account\'s refresh_token cookie is valid', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/setCookie', createCookieRoute('access_token', ''));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        stormpathAccount.status = 'DISABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should set req.user and res.locals.user if an access_token cookie is present and valid', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should set req.user and res.locals.user if an invalid access_token cookie is present with a valid refresh_token cookie', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/setCookie', createCookieRoute('access_token', 'hiii'));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if an invalid refresh_token cookie is present, and no access_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/setCookie', createCookieRoute('refresh_token', 'blah'));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/setCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should set req.user and res.locals.user if a valid refresh_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/deleteCookie', createCookieRoute('access_token', ''));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/deleteCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should expand customData if a valid access_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should expand customData if a valid refresh_token cookie is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/deleteCookie', createCookieRoute('access_token', ''));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/deleteCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should expand customData if an invalid access_token cookie is present along with a valid refresh_token cookie', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/login', login);
    app.get('/deleteCookie', createCookieRoute('access_token', 'woot'));
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/login')
          .send({
            login: accountData.email,
            password: accountData.password
          })
          .expect(302)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/deleteCookie')
          .expect(200)
          .end(callback);
      },
      function(callback) {
        agent
          .get('/')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if an invalid basic auth header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .auth('invalid', 'auth')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should continue immediately if an invalid bearer header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/', getUser, function(req, res) {
      assert.equal(req.user, undefined);
      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .set('Authorization', 'Bearer: SOME_INVALID_TOKEN')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should set req.user if a valid basic auth header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .auth(stormpathApiKey.id, stormpathApiKey.secret)
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it('should expand customData if a valid basic auth header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .get('/')
          .auth(stormpathApiKey.id, stormpathApiKey.secret)
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it.skip('should set req.user if a valid bearer header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/oauth/token', getToken);
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);

      res.send('success');
    });

    var accessToken;
    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/oauth/token?grant_type=client_credentials')
          .auth(stormpathApiKey.id, stormpathApiKey.secret)
          .set('Content-Type', 'x-www-form-urlencoded')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            var json = JSON.parse(res.text);
            accessToken = json.access_token;

            callback();
          });
      },
      function(callback) {
        agent
          .get('/')
          .set('Authorization', 'Bearer: ' + accessToken)
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });

  it.skip('should expand customData if a valid bearer header is present', function(done) {
    var app = createFakeExpressApp();
    var agent = request.agent(app);

    app.post('/oauth/token', getToken);
    app.get('/', getUser, function(req, res) {
      assert.equal(req.user.givenName, accountData.givenName);
      assert.equal(req.user.surname, accountData.surname);
      assert.equal(req.user.email, accountData.email);
      assert(req.user.customData.createdAt);

      res.send('success');
    });

    var accessToken;
    async.series([
      function(callback) {
        stormpathAccount.status = 'ENABLED';
        stormpathAccount.save(function(err) {
          callback(err);
        });
      },
      function(callback) {
        agent
          .post('/oauth/token?grant_type=client_credentials')
          .auth(stormpathApiKey.id, stormpathApiKey.secret)
          .set('Content-Type', 'x-www-form-urlencoded')
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            var json = JSON.parse(res.text);
            accessToken = json.access_token;

            callback();
          });
      },
      function(callback) {
        agent
          .get('/')
          .set('Authorization', 'Bearer: ' + accessToken)
          .expect(200)
          .end(function(err, res) {
            if (err) {
              return callback(err);
            }

            assert.equal(res.text, 'success');
            callback();
          });
      }
    ], function(err) {
      done(err);
    });
  });
});
