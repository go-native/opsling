import chalk from 'chalk';

const WORDMARK = [
  ' ██████╗ ██████╗ ███████╗██╗     ██╗███╗   ██╗ ██████╗ ',
  '██╔═══██╗██╔══██╗██╔════╝██║     ██║████╗  ██║██╔════╝ ',
  '██║   ██║██████╔╝███████╗██║     ██║██╔██╗ ██║██║  ███╗',
  '██║   ██║██╔═══╝ ╚════██║██║     ██║██║╚██╗██║██║   ██║',
  '╚██████╔╝██║     ███████║███████╗██║██║ ╚████║╚██████╔╝',
  ' ╚═════╝ ╚═╝     ╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ',
].join('\n');

export const printBanner = (version: string): void => {
  process.stdout.write('\n');
  process.stdout.write(`${chalk.cyan.bold(WORDMARK)}\n`);
  process.stdout.write(
    ` ${chalk.gray('v')}${chalk.white.bold(version)}  ${chalk.gray("— watching your stuff so you don't have to")}\n\n`,
  );
};
