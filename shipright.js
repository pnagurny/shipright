var fs = require('fs')
  , express = require('express')
  , app = express()
  , mongoose = require('mongoose')
  , flashify = require('flashify')
  , passport = require('passport')
  , LocalStrategy = require('passport-local').Strategy
  , passportLocalMongoose = require('passport-local-mongoose')
  , RedisStore = require('connect-redis')(express)
  , redis = require('redis');

var moment = require('moment');
var marked = require('marked');
marked.setOptions({
    smartypants: true
  , highlight: function(code) {
      return require('highlight.js').highlightAuto(code).value;
    }
});

var sessionStore = new RedisStore();

config   = require('./config');
database = require('./db');

// quick hack
config.git.data.path = __dirname + '/' + config.git.data.path;

// GLOBAL LIBRARIES
// TODO: should we do this?
_     = require('underscore');
async = require('async');
Git   = require('nodegit');
git   = require('gitty'); // thanks, @gordonwritescode!

Account = People  = require('./models/Account').Account;
Comment           = require('./models/Comment').Comment;
Issue             = require('./models/Issue').Issue;
Organization      = require('./models/Organization').Organization;
Project           = require('./models/Project').Project;

Actor             = require('./models/Actor').Actor;
Activity          = require('./models/Activity').Activity;

var pages         = require('./controllers/pages');
var people        = require('./controllers/people');
var projects      = require('./controllers/projects');
var organizations = require('./controllers/organizations');
var issues        = require('./controllers/issues');

app.locals.pretty = true;
app.locals.moment = moment;
app.locals.marked = function( inputString , context ) {
  var parsed = marked( inputString );

  if (context && context.project && context.issue) {
    parsed = parsed.replace(/\#(\d+)/g, '<a href="/'+context.project._owner.slug+'/'+context.project.slug+'/issues/$1">#$1</a>');
  
    // TODO: use a job scheduler
    var references = parsed.match(/\#(\d+)/g);
    if (references) {
      references.forEach(function(id) {
        var query = { _project: context.project._id , id: id.slice(1) };
        console.log(query);
        Issue.findOne( query ).exec(function(err, issue) {
          if (err || !issue) { return; }

          var list = issue._references.map(function(x) { return x._id; });
          console.log(list);
          if (issue._references.map(function(x) { return x._issue.toString(); }).indexOf( context.issue._id.toString() ) < 0) {
            issue._references.push({
                _issue: context.issue._id
              , _creator: (context.comment) ? context.comment._author : context.issue._creator._id
            });
            issue.save(function(err) {
              if (err) { console.log(err); }
              // TODO: broadcast event on a redis channel
            });
          }
        });
      });
    }
  }
  return parsed;
};

app.use(require('less-middleware')({ 
    debug: true
  , src: __dirname + '/private'
  , dest: __dirname + '/public'
}));
// any files in the /public directory will be accessible over the web,
// css, js, images... anything the browser will need.
app.use(express.static(__dirname + '/public'));

// jade is the default templating engine.
app.engine('jade', require('jade').__express);

// set up middlewares for session handling
app.use(express.cookieParser( config.cookieSecret ));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(express.session({
    secret: config.cookieSecret
  , store: sessionStore
}));

/* Configure the registration and login system */
app.use(passport.initialize());
app.use(passport.session());

app.set('view engine', 'jade');

passport.use(new LocalStrategy( Account.authenticate() ) );

passport.serializeUser( Account.serializeUser() );
passport.deserializeUser( Account.deserializeUser() );

/* configure some local variables for use later */
app.use(function(req, res, next) {
  res.locals.user = req.user;
  res.locals.next = req.path;

  console.log(req.method + ' ' + req.path);

  // TODO: consider moving to a prototype on the response
  res.provide = function(err, resource, options) {
    if (err) { resource = err; }
    if (!options) { options = {}; }

    res.format({
        // TODO: strip non-public fields from pure JSON results
        json: function() { res.send( resource ); }
      , html: function() {
          if (options.template) {
            // TODO: determine appropriate resource format
            res.render( options.template , _.extend({ resource: resource } , resource ) );
          } else {
            res.send( resource );
          }
        }
    });
  };

  next();
});

function requireLogin(req, res, next) {
  if (req.user) { return next(); }
  // require the user to log in
  res.status(401).render('login', {
    next: req.path
  });
}

app.get('/', pages.index );

app.get('/register', function(req, res) {
  res.render('register');
});

app.get('/login', function(req, res) {
  var next = req.param('next') ? req.param('next') : '/';
  if (req.user) {
    res.redirect('next')
  } else {
    res.render('login', {
      next: next
    });
  }
});

/* when a POST request is made to '/register'... */
app.post('/register', function(req, res) {
  Account.register(new Account({ email : req.body.email, username : req.body.username }), req.body.password, function(err, user) {
    if (err) {
      console.log(err);
      return res.render('register', { user : user });
    }

    return res.redirect( next );

    req.login( user , function(err) {
      var next = req.param('next') ? req.param('next') : '/';
      
    });
  });
});

app.post('/login', passport.authenticate('local'), function(req, res) {
  var next = req.param('next') ? req.param('next') : '';
  if (next) { // TODO: prevent malicious redirects
    res.redirect( next );
  } else {
    //req.flash('info', '<strong>Welcome back!</strong>  We\'re glad to have you.');
    res.redirect('/');
  }
});

app.get('/logout', function(req, res, next) {
  req.logout();
  res.redirect('/');
});

app.get('/projects',                          projects.list );
app.get('/projects/new', requireLogin ,       projects.createForm );
app.post('/projects',    requireLogin ,       projects.create );

app.get('/:actorSlug/:projectSlug',                                 setupRepo, projects.view );
app.get('/:actorSlug/:projectSlug/tree/:branchName',                setupRepo, projects.view );
app.get('/:actorSlug/:projectSlug/issues',                          setupRepo, issues.list );
app.get('/:actorSlug/:projectSlug/issues/:issueID',                 setupRepo, issues.view );
app.get('/:actorSlug/:projectSlug/issues/new',                      setupRepo, issues.createForm );
app.post('/:actorSlug/:projectSlug/issues',          requireLogin , setupRepo, issues.create );

app.post('/:actorSlug/:projectSlug/issues/:issueID/comments', requireLogin , setupRepo, issues.addComment );

function setupRepo(req, res, next) {
  req.params.projectSlug = req.params.projectSlug.replace('.git', '');
  req.params.uniqueSlug = req.param('actorSlug') + '/' + req.param('projectSlug');

  next();
}
//app.get('/:actorSlug/:projectSlug.git/info/refs',               setupRepo , projects.git.refs );
app.get('/:actorSlug/:projectSlug/blob/:branchName/:filePath',  setupRepo , projects.viewBlob );
app.get('/:actorSlug/:projectSlug/commit/:commitID',            setupRepo , projects.viewCommit );

function setupPushover(req, res, next) {
  Project.lookup( req.param('uniqueSlug') , function(err, project) {
    if (err) { console.log(err); }
    if (!project) { return next(); }

    req.projectID = project._id.toString();

    next();
  });
}
var pushover = require('./lib/pushover');

var repos = pushover( config.git.data.path , {
  checkout: true
});

repos.on('push', function (push) {
  console.log('push ' + push.repo + '/' + push.commit
      + ' (' + push.branch + ')'
  );
  push.accept();
});
repos.on('fetch', function (fetch) {
  console.log('fetch ' + fetch.commit);
  fetch.accept();
});

app.get('*', function(req, res, next) {
  req.on('readable', function() { console.log('readable'); });
  req.on('end', function() { console.log('end'); });
  req.on('error', function() { console.log('error'); });
  req.on('close', function() { console.log('close'); });
  req.on('data', function(buf) {
    console.log(buf);
  });
  next();
});

app.get('/:actorSlug/:projectSlug.git*', setupRepo , setupPushover , function(req, res) {
  console.log('handling get....')
  repos.handle(req, res);
});
app.post('/:actorSlug/:projectSlug.git*', setupRepo , setupPushover , function(req, res) {
  console.log('handling post....')
  repos.handle(req, res);
});

app.get('/people', people.list);

app.get('/:organizationSlug', organizations.view );
app.get('/:usernameSlug',     people.view );

app.get('*', function(req, res) {
  res.status(404).render('404');
});

app.listen( config.appPort , function() {
  console.log('Demo application is now listening on http://localhost:' + config.appPort + ' ...');
});

