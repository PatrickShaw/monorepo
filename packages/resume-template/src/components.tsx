/* eslint-disable */
import { Typography, withStyles } from '@material-ui/core';
import classNames from 'classnames';
import { format as formatDate } from 'date-fns/esm/index';
import * as React from 'react';
import envelope from './envelope';
import github from './github';
import linkedin from './linkedin';

const Contact = withStyles(
  theme => ({
    contact: {
      color: theme.palette.getContrastText(theme.palette.primary.main),
    },
    icon: {
      width: '1em',
      height: '1em',
      verticalAlign: 'middle',
      marginRight: '0.5em',
    },
  }),
  { withTheme: true },
)(({ children, icon, classes, ...other }) => (
  <>
    <EntryText className={classes.contact} {...other}>
      <img {...icon} aria-hidden className={classes.icon} />
      {children}
    </EntryText>
  </>
));

const ResumeLink = withStyles({
  printLink: {
    display: 'none',
  },
  '@media print': {
    webLink: {
      display: 'none',
    },
    printLink: {
      display: 'inline-block',
    },
  },
})(({ title, children, classes, printAlt, ...other }) => (
  <>
    <a {...other} className={classes.webLink}>
      {children}
    </a>
    <a {...other} className={classes.printLink}>
      {other.href.replace(/(https?:\/\/(www\.)?|mailto:)/, '')}
    </a>
  </>
));

const Header = withStyles(
  theme => ({
    header: {
      background: theme.palette.primary.main,
    },
    heading: {
      color: theme.palette.getContrastText(theme.palette.primary.main),
    },
    headingContainer: {
      gridColumn: '2',
      flexDirection: 'row',
      alignItems: 'center',
      display: 'flex',
    },
    contact: {
      gridColumn: '3',
    },
  }),
  { withTheme: true },
)(({ classes, otherClasses, children, data }) => (
  <header className={classNames(classes.header, otherClasses.header)}>
    <div className={classes.headingContainer}>
      <Typography
        variant="h3"
        className={classNames(classes.heading, otherClasses.heading)}
      >
        {children}
      </Typography>
    </div>
    <section>
      {/*
        <Contact>
          <a href={data.details.website}>{data.details.website}</a>
        </Contact>
      */}
      <Contact icon={{ src: envelope }}>
        {/*
          People print resumes and most viewing on a computer don't expect links 
          so have to show the link as text
        */}
        <ResumeLink href={`mailto:${data.details.email}`} title="Email link">
          Email
        </ResumeLink>
      </Contact>
      <Contact icon={{ src: linkedin }}>
        <ResumeLink href={data.details.linkedin} title="LinkedIn link">
          LinkedIn
        </ResumeLink>
      </Contact>
      <Contact icon={{ src: github }} title="GitHub link">
        <ResumeLink href={data.details.github}>Github</ResumeLink>
      </Contact>
    </section>
  </header>
));

const EntryTopic = withStyles({
  entryTopic: {
    '&>*': {
      // '&:not(:last-child)': {
      marginBottom: '24px',
      // },<
    },
  },
})(({ children, classes, ...other }) => (
  <Topic otherClasses={{ container: classes.entryTopic }} {...other}>
    {children}
  </Topic>
));

const Topic = withStyles(
  theme => ({
    heading: {
      fontWeight: theme.typography.fontWeightMedium,
    },
    /*'@media print': {
    container: {
      pageBreakInside: 'avoid',
      breakInside: 'avoid',
    },
  },*/
  }),
  { withTheme: true },
)(({ heading, children, classes, otherClasses = { container: undefined }, ...other }) => (
  <section className={otherClasses.container}>
    <Typography
      variant="subtitle2"
      color="primary"
      component="h1"
      // color="textSecondary"
      className={classes.heading}
      {...other}
    >
      {heading}
    </Typography>
    {children}
  </section>
));

const Entry = withStyles(
  theme => ({
    subtext: {
      marginBottom: '12px',
    },
    entryHeading: {
      display: 'inline-block',
    },
    leftHeading: {
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  { withTheme: true },
)(
  ({
    leftHeading,
    description,
    startDate,
    endDate,
    rightHeading,
    keyPoints,
    classes,
    subtext,
    dateFormat = 'MMM YYYY',
    children,
  }) => (
    <section>
      {leftHeading ? (
        <EntryHeading
          component="h1"
          className={classNames(classes.entryHeading, classes.leftHeading)}
        >
          {leftHeading} /&nbsp;
        </EntryHeading>
      ) : null}
      <EntryHeading component="h2" className={classes.entryHeading}>
        {rightHeading}
      </EntryHeading>
      {/*TODO: Subtext won't appear if no date*/}
      {startDate || endDate ? (
        <EntryText component="p" variant="caption" className={classes.subtext}>
          <DateRange start={startDate} end={endDate} format={dateFormat} />
          {subtext ? `, ${subtext}` : null}
        </EntryText>
      ) : null}
      {children}
      {description ? (
        <EntryText component="p" color="textSecondary">
          {description.replace(/\.?\s*$/, '.')}
        </EntryText>
      ) : null}
      <KeyPoints component="p" color="textSecondary" keyPoints={keyPoints} />
    </section>
  ),
);

const EducationEntry = ({ school, grade, course, ...other }) => (
  <Entry
    leftHeading={school}
    rightHeading={course}
    subtext={`GPA: ${grade.gpa}, WAM: ${grade.wam}`}
    {...other}
  />
);

const DateRange = ({ start, end, format }) => (
  <>
    {formatDate(start, format, { awareOfUnicodeTokens: true })}
    {end !== undefined ? (
      <>
        {' '}
        <span aria-label="to">-</span>{' '}
        {end === null
          ? 'Current'
          : formatDate(end, format, { awareOfUnicodeTokens: true })}
      </>
    ) : null}
  </>
);
const EntryHeading = ({ children, ...other }) => (
  <Typography variant="subtitle1" component="h1" {...other}>
    {children}
  </Typography>
);
const EntryText = ({ children, ...other }) => (
  <Typography variant="caption" color="textSecondary" {...other}>
    {children}
  </Typography>
);
const ListLabel = withStyles(
  theme => ({
    label: {
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  { withTheme: true },
)(({ children, classes, ...other }) => (
  <EntryText className={classes.label} color="textPrimary" {...other}>
    {children}
  </EntryText>
));
const LabeledList = withStyles({
  list: {
    '&>*': {
      '&:not(:last-child)': {
        marginBottom: '12px',
      },
    },
  },
})(({ classes, ...other }) => (
  <div className={classes.list}>
    {other.items.map(({ label, items }, index) => (
      <p key={index}>
        <ListLabel component="span" style={{ display: 'inline' }} paragraph={false}>
          {label}:
        </ListLabel>{' '}
        <EntryText component="span" style={{ display: 'inline' }} paragraph={false}>
          {skillsSentence(items)}
        </EntryText>
      </p>
    ))}
  </div>
));
const Ul = withStyles({
  list: {
    listStylePosition: 'inside',
    paddingLeft: 0,
    marginBlockStart: '0em',
    marginBlockEnd: '0em',
  },
})(({ children, classes }) => <ul className={classes.list}>{children}</ul>);
const KeyPointItem = ({ children, ...other }) => (
  <EntryText component="span" {...other}>
    {children}
  </EntryText>
);
const KeyPoints = ({ keyPoints, ...other }) =>
  keyPoints && keyPoints.length > 0 ? (
    <>
      {keyPoints.slice(0, -1).map((keyPoint, index) => (
        <KeyPointItem {...other} key={index}>
          {keyPoint}
        </KeyPointItem>
      ))}
      {
        <KeyPointItem {...other} gutterBottom>
          {keyPoints[keyPoints.length - 1]}
        </KeyPointItem>
      }
    </>
  ) : null;
const ExperienceEntry = ({ company, job, location, ...other }) => (
  <Entry leftHeading={company} rightHeading={job} subtext={location} {...other} />
);

const VolunteeringExperience = ({ organization, role, ...other }) => (
  <Entry leftHeading={organization} rightHeading={role} {...other} />
);
const listSentence = items =>
  [items.slice(0, -1).join(', '), items.slice(-1)[0]].join(
    items.length < 2 ? '' : ' and ',
  );
const itemsString = items => items.join(' • ');
/*
 */
const tecnologiesSentence = technologies => `Technologies: ${listSentence(technologies)}`;
const skillsSentence = skills => itemsString(skills);

const ProjectEntry = ({ name, types, ...other }) => (
  <Entry rightHeading={name} {...other} startDate={undefined} endDate={undefined} />
);

const HackathonEntry = withStyles({
  prize: {
    marginBottom: '12px',
  },
})(({ hack, event, prize, technologies, classes, ...other }) => (
  <Entry
    leftHeading={event}
    rightHeading={hack}
    {...other}
    startDate={undefined}
    endDate={undefined}
  >
    <Typography
      component="p"
      variant="caption"
      fontWeight="medium"
      className={classes.prize}
    >
      <em>{prize}</em>
    </Typography>
  </Entry>
));

const EntryMapper = ({ Component, data }) =>
  data.map((item, index) => <Component {...item} key={index} />);

export const Page = withStyles({
  pageGrid: {
    display: 'grid',
    // gridAutoColumns: 'auto',
    gridTemplateColumns:
      'minmax(24px, 1fr) minmax(392px, 444px) minmax(252px, 300px) minmax(24px, 1fr)',
    gridGap: '24px',
  },
  margin: {
    visibility: 'hidden',
  },
  header: {
    gridColumn: 'span 4',
    paddingTop: '32px',
    paddingBottom: '32px',
  },
  topicEntries: {
    '&>*': {
      // '&:not(:last-child)': {
      marginBottom: '24px',
      // },
    },
  },
  main: {
    gridColumn: 2,
    display: 'flex',
    justifyContent: 'space-between',
    flexDirection: 'column',
  },
  aside: {
    display: 'flex',
    justifyContent: 'space-between',
    flexDirection: 'column',
  },
})(({ classes, data }) => (
  <div className={classNames(classes.pageContainer, classes.pageGrid)}>
    <Header
      details={data.details}
      otherClasses={{
        header: classNames(classes.header, classes.pageGrid),
      }}
      data={data}
    >
      {data.details.name}
    </Header>
    <main className={classes.main}>
      <EntryTopic heading="Experience">
        <EntryMapper Component={ExperienceEntry} data={data.work} />
      </EntryTopic>
      <EntryTopic heading="Projects">
        <EntryMapper Component={ProjectEntry} data={data.projects} />
      </EntryTopic>
    </main>
    <aside className={classes.aside}>
      <EntryTopic heading="Education">
        <EntryMapper Component={EducationEntry} data={data.education} />
      </EntryTopic>
      <EntryTopic heading="Hackathons">
        <EntryMapper Component={HackathonEntry} data={data.hackathons} />
      </EntryTopic>
      <EntryTopic heading="Technical skills">
        <LabeledList items={data.technicalSkills} />
      </EntryTopic>
    </aside>
    <div className={classes.margin} />
  </div>
));
